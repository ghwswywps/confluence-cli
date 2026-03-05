import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium, firefox, webkit } from "playwright-core";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── 常量 & 配置 (修改版) ──────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const AUTH_PATH  = path.join(__dirname, 'auth.json');

const BROWSER_TYPE    = process.env.BROWSER_TYPE    || 'chromium';
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || 'chrome';

// 建议将英文关键词全部改为小写，方便做忽略大小写的匹配
const LOGIN_KEYWORDS = [
  // 中文登录关键词
  '企微扫码', '密码登录', '验证码登录', '企业微信登录', '扫描二维码登录', '单点登录', '账号登录', '账号密码登录',
  // 英文登录关键词 (全部小写)
  'sign in', 'sign up', 'username', 'password', 'remember me', 'ldap', 'login'
];

// 增加了 sign_in (GitLab 常用) 和 oauth
const LOGIN_URL_RE   = /(login|sso|auth|sign_in|oauth)/i;

// ── 工具函数 (修改版) ──────────────────────────────────────────────────
function getBrowserEngine() {
  switch (BROWSER_TYPE) {
    case 'firefox': return firefox;
    case 'webkit':  return webkit;
    default:        return chromium;
  }
}

function isLoginPage(content, url) {
  const lowerContent = content.toLowerCase();
  
  // 1. URL 命中登录特征
  if (LOGIN_URL_RE.test(url)) return true;
  
  // 2. 页面内容过短（通常是空白页或跳转页）
  if (content.trim().length < 150) return true;
  
  // 3. 忽略大小写匹配登录关键词
  return LOGIN_KEYWORDS.some(kw => lowerContent.includes(kw));
}

function isLoggedInContent(content, url) {
  const lowerContent = content.toLowerCase();
  
  // 通用登录成功判断：URL 无登录特征 + 内容足够长 + 无登录关键词
  return !LOGIN_URL_RE.test(url)
    && content.trim().length > 500
    && !LOGIN_KEYWORDS.some(kw => lowerContent.includes(kw));
}

// ── MCP Server ───────────────────────────────────────────────
const server = new Server(
  { name: "tuhu-wiki-fetcher", version: "6.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "fetch_wiki_page",
    description: "抓取途虎 Wiki 等需要鉴权的网页。如果鉴权过期，会自动弹窗要求用户扫码登录。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要抓取的 Wiki 页面 URL" }
      },
      required: ["url"],
    },
  }],
}));

// ── 核心抓取逻辑 ─────────────────────────────────────────────
async function launchBrowser(headless) {
  const engine = getBrowserEngine();
  const launchOpts = { headless };
  if (BROWSER_CHANNEL) {
    launchOpts.channel = BROWSER_CHANNEL;
  }
  return engine.launch(launchOpts);
}

async function waitForLoginComplete(page) {
  console.error("🌐 监测到登录拦截，请在弹出的浏览器中扫码...");

  const MAX_WAIT_MS = 5 * 60 * 1000; // 最多等 5 分钟
  const POLL_INTERVAL = 2000;
  const STABLE_REQUIRED = 2;

  let stableCount = 0;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    // waitForTimeout 也放进 try/catch，防止页面导航时抛异常导致浏览器被关闭
    try {
      await page.waitForTimeout(POLL_INTERVAL);
      const checkContent = await page.evaluate(() => document.body.innerText);
      const checkUrl = page.url();

      if (isLoggedInContent(checkContent, checkUrl)) {
        stableCount++;
        console.error(`✅ 正在确认正文稳定性... (${stableCount}/${STABLE_REQUIRED})`);
        if (stableCount >= STABLE_REQUIRED) return;
      } else {
        stableCount = 0;
      }
    } catch {
      // 页面正在跳转时 evaluate / waitForTimeout 可能报错，忽略即可
      stableCount = 0;
    }
  }

  throw new Error('等待扫码登录超时（5 分钟）');
}

async function fetchPage(url, headless) {
  const hasAuth = fs.existsSync(AUTH_PATH);
  console.error(`[DEBUG] fetchPage called: headless=${headless}, hasAuth=${hasAuth}, url=${url}`);
  
  const browser = await launchBrowser(headless);

  try {
    const context = await browser.newContext(hasAuth ? { storageState: AUTH_PATH } : {});
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    let content = await page.evaluate(() => document.body.innerText);
    const currentUrl = page.url();
    
    console.error(`[DEBUG] Page loaded: url=${currentUrl}, contentLen=${content.trim().length}`);
    console.error(`[DEBUG] isLoginPage result: ${isLoginPage(content, currentUrl)}`);

    if (isLoginPage(content, currentUrl)) {
      console.error(`[DEBUG] Detected login page! headless=${headless}`);
      if (headless) {
        console.error(`[DEBUG] Throwing NEEDS_LOGIN error`);
        await browser.close();
        throw new Error('NEEDS_LOGIN');
      }

      // 非 headless：等待用户扫码
      await waitForLoginComplete(page);

      console.error("🎉 登录成功！正在保存凭证并抓取...");
      await page.waitForTimeout(2000);
      await context.storageState({ path: AUTH_PATH });
      content = await page.evaluate(() => document.body.innerText);
    }

    await browser.close();
    return content;
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

// ── 工具请求处理 ─────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "fetch_wiki_page") {
    throw new Error("未知工具");
  }

  const url = request.params.arguments.url;

  try {
    // 1. 先尝试静默后台抓取
    const content = await fetchPage(url, true);
    return { content: [{ type: "text", text: content }] };
  } catch (error) {
    if (error.message !== 'NEEDS_LOGIN') {
      return { content: [{ type: "text", text: `抓取异常: ${error.message}` }], isError: true };
    }
  }

  try {
    // 2. 后台失败，唤起浏览器让用户扫码
    console.error("⚠️ 正在唤起浏览器进行手动扫码登录...");
    const content = await fetchPage(url, false);
    return { content: [{ type: "text", text: content }] };
  } catch (uiError) {
    return { content: [{ type: "text", text: `手动登录抓取失败: ${uiError.message}` }], isError: true };
  }
});

// ── 启动 ─────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);

console.error(`🚀 途虎 Wiki 智能抓取服务已启动 (browser: ${BROWSER_TYPE}${BROWSER_CHANNEL ? '/' + BROWSER_CHANNEL : ''})`);