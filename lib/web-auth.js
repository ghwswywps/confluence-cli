const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');

// Auth storage path
const AUTH_DIR = path.join(os.homedir(), '.confluence-cli');
const AUTH_FILE = path.join(AUTH_DIR, 'auth.json');

// Login detection keywords
const LOGIN_KEYWORDS = [
  // Chinese login keywords
  '企微扫码', '密码登录', '验证码登录', '企业微信登录', '扫描二维码登录', '单点登录', '账号登录', '账号密码登录',
  // English login keywords (all lowercase)
  'sign in', 'sign up', 'username', 'password', 'remember me', 'ldap', 'login'
];

// Login URL patterns
const LOGIN_URL_RE = /(login|sso|auth|sign_in|oauth)/i;

/**
 * Get the browser engine based on environment variable
 */
function getBrowserEngine() {
  const browserType = process.env.BROWSER_TYPE || 'chromium';
  const browserChannel = process.env.BROWSER_CHANNEL || 'chrome';
  
  // Dynamic import for playwright-core (ES module)
  const playwright = require('playwright-core');
  
  switch (browserType) {
    case 'firefox': 
      return { browser: playwright.firefox, channel: null };
    case 'webkit': 
      return { browser: playwright.webkit, channel: null };
    default: 
      return { browser: playwright.chromium, channel: browserChannel };
  }
}

/**
 * Check if the page content indicates a login page
 */
function isLoginPage(content, url) {
  const lowerContent = content.toLowerCase();
  
  // 1. URL matches login patterns
  if (LOGIN_URL_RE.test(url)) return true;
  
  // 2. Page content is too short (usually blank or redirect page)
  if (content.trim().length < 150) return true;
  
  // 3. Case-insensitive match for login keywords
  return LOGIN_KEYWORDS.some(kw => lowerContent.includes(kw));
}

/**
 * Check if the content indicates a successful login
 */
function isLoggedInContent(content, url) {
  const lowerContent = content.toLowerCase();
  
  // Successful login: URL has no login features + content is long enough + no login keywords
  return !LOGIN_URL_RE.test(url)
    && content.trim().length > 500
    && !LOGIN_KEYWORDS.some(kw => lowerContent.includes(kw));
}

/**
 * Wait for user to complete login in the browser
 */
async function waitForLoginComplete(page) {
  console.log(chalk.yellow('🌐 请在弹出的浏览器中完成登录...'));

  const MAX_WAIT_MS = 5 * 60 * 1000; // Max 5 minutes
  const POLL_INTERVAL = 2000;
  const STABLE_REQUIRED = 2;

  let stableCount = 0;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      await page.waitForTimeout(POLL_INTERVAL);
      const checkContent = await page.evaluate(() => document.body.innerText);
      const checkUrl = page.url();

      if (isLoggedInContent(checkContent, checkUrl)) {
        stableCount++;
        console.log(chalk.gray(`✅ 正在确认登录状态... (${stableCount}/${STABLE_REQUIRED})`));
        if (stableCount >= STABLE_REQUIRED) return;
      } else {
        stableCount = 0;
      }
    } catch {
      // Page might be navigating, reset counter
      stableCount = 0;
    }
  }

  throw new Error('等待登录超时（5 分钟）');
}

/**
 * Launch browser with specified options
 */
async function launchBrowser(headless) {
  const { browser: engine, channel } = getBrowserEngine();
  const launchOpts = { headless };
  
  if (channel) {
    launchOpts.channel = channel;
  }
  
  return engine.launch(launchOpts);
}

/**
 * Perform web-based login and save auth state
 * @param {string} domain - Confluence domain (e.g., 'your-company.atlassian.net')
 * @param {object} options - Additional options
 * @param {string} options.protocol - Protocol to use (default: 'https')
 * @param {string} options.apiPath - API path (default: '/wiki/rest/api' for cloud)
 * @returns {Promise<object>} - Auth configuration object
 */
async function performWebLogin(domain, options = {}) {
  const protocol = options.protocol || 'https';
  const apiPath = options.apiPath || '/wiki/rest/api';
  
  // Normalize domain
  const normalizedDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  
  // Build login URL
  const loginUrl = `${protocol}://${normalizedDomain}`;
  
  console.log(chalk.blue('🚀 Confluence Web Login'));
  console.log(`Domain: ${chalk.gray(normalizedDomain)}`);
  console.log(`Login URL: ${chalk.gray(loginUrl)}`);
  console.log('');

  const browser = await launchBrowser(false); // headless=false to show browser

  try {
    // Check for existing auth
    const hasExistingAuth = fs.existsSync(AUTH_FILE);
    let context;
    
    if (hasExistingAuth) {
      try {
        context = await browser.newContext({ storageState: AUTH_FILE });
      } catch (e) {
        // If existing auth is invalid, start fresh
        context = await browser.newContext();
      }
    } else {
      context = await browser.newContext();
    }
    
    const page = await context.newPage();

    // Navigate to Confluence
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    let content = await page.evaluate(() => document.body.innerText);
    const currentUrl = page.url();

    if (isLoginPage(content, currentUrl)) {
      // Wait for user to complete login
      await waitForLoginComplete(page);
      
      console.log(chalk.green('🎉 登录成功！正在保存凭证...'));
      await page.waitForTimeout(2000);
    } else {
      console.log(chalk.green('✅ 已检测到有效登录状态'));
    }

    // Save auth state (cookies and localStorage) to auth.json
    await context.storageState({ path: AUTH_FILE });
    
    // Read the saved auth state to extract cookies
    const authState = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    
    // Convert cookies to cookie string for HTTP headers
    const cookieString = authState.cookies
      ? authState.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
      : '';

    // Get current user info if possible
    let userEmail = null;
    try {
      // Try to get user info from the page or API
      const apiResponse = await page.evaluate(async () => {
        try {
          const resp = await fetch('/wiki/rest/api/user/current');
          if (resp.ok) {
            return await resp.json();
          }
        } catch (e) {
          // Ignore
        }
        return null;
      });
      
      if (apiResponse && apiResponse.email) {
        userEmail = apiResponse.email;
      }
    } catch (e) {
      // Ignore errors getting user info
    }

    await browser.close();

    // Create config object with cookies for API requests
    const config = {
      domain: normalizedDomain,
      protocol: protocol,
      apiPath: apiPath,
      authType: 'web',
      email: userEmail,
      cookies: cookieString,
      authFile: AUTH_FILE
    };

    // Save config
    const configFile = path.join(AUTH_DIR, 'config.json');
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

    console.log('');
    console.log(chalk.green('✅ Web 登录配置保存成功！'));
    console.log(`配置文件: ${chalk.gray(configFile)}`);
    console.log(`认证文件: ${chalk.gray(AUTH_FILE)}`);
    console.log('');
    console.log(chalk.yellow('💡 提示: 现在您可以使用所有 confluence 命令了'));

    return config;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

/**
 * Load auth state from file
 * @returns {object|null} - Auth state object or null if not found
 */
function loadAuthState() {
  if (!fs.existsSync(AUTH_FILE)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Check if web auth is available
 * @returns {boolean}
 */
function hasWebAuth() {
  return fs.existsSync(AUTH_FILE);
}

/**
 * Get cookies from auth state for axios
 * @param {object} authState - Auth state from loadAuthState()
 * @returns {string} - Cookie string for HTTP headers
 */
function getCookiesForRequest(authState) {
  if (!authState || !authState.cookies) {
    return '';
  }

  // Convert cookies array to header string
  return authState.cookies
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

module.exports = {
  performWebLogin,
  loadAuthState,
  hasWebAuth,
  getCookiesForRequest,
  AUTH_FILE,
  AUTH_DIR
};