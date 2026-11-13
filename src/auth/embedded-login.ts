/**
 * 内嵌登录窗口：在插件内打开 leetcode.cn 登录页，登录成功后自己把 cookie 取走。
 *
 * 依据（本机实测，Obsidian 1.9.14 / Electron 37.6.0）：
 * renderer 里 `require("electron").remote` 依然存在，且 `remote.BrowserWindow` 是构造函数、
 * `remote.session` 是模块对象。Electron 官方从 14 起就移除了 remote，
 * 所以这一定是 Obsidian 自己注入的 @electron/remote —— 也就是说这是内部实现，
 * 未来版本随时可能消失。所有入口都必须能优雅降级回"手动粘贴"。
 *
 * 之所以不复用默认 session：独立 partition 更干净，不会和 Obsidian 主窗口的 cookie 互相污染，
 * 而且我们本来就把取到的值写进插件 data.json，不依赖 partition 的持久化能力。
 */

const PARTITION = "persist:leetcode-tracker-login";
const LOGIN_URL = "https://leetcode.cn/accounts/login/";
const POLL_MS = 1200;
/** 匿名态下发的是空串或很短的占位，够长的才可能是真 session */
const MIN_SESSION_LEN = 40;

interface CookieLike {
  name: string;
  value: string;
}

interface SessionHandle {
  cookies: {
    get(filter: { url?: string }): Promise<CookieLike[]>;
  };
}

interface WebContentsHandle {
  session: SessionHandle;
  setWindowOpenHandler(handler: () => { action: "allow" | "deny" }): void;
}

interface BrowserWindowHandle {
  webContents: WebContentsHandle;
  loadURL(url: string): Promise<void>;
  isDestroyed(): boolean;
  destroy(): void;
  on(event: string, cb: () => void): void;
  focus(): void;
}

interface ElectronRemote {
  BrowserWindow: new (opts: Record<string, unknown>) => BrowserWindowHandle;
  session: unknown;
}

function getRemote(): ElectronRemote | null {
  try {
    const req = (window as unknown as { require?: (m: string) => unknown }).require;
    if (!req) return null;
    const electron = req("electron") as { remote?: ElectronRemote } | undefined;
    const r = electron?.remote;
    if (!r || typeof r.BrowserWindow !== "function") return null;
    return r;
  } catch {
    return null;
  }
}

/** 桌面端且 Obsidian 仍暴露 remote 时为 true */
export function isEmbeddedLoginAvailable(): boolean {
  return getRemote() !== null;
}

/** 拼成 client.ts 认识的那种 `NAME=value; NAME=value` 串 */
export function buildCookieString(cookies: CookieLike[]): string {
  const parts: string[] = [];
  for (const name of ["LEETCODE_SESSION", "csrftoken"]) {
    const c = cookies.find((x) => x.name === name && x.value);
    if (c) parts.push(`${name}=${c.value}`);
  }
  return parts.join("; ");
}

/** 从用户粘贴的整条 Cookie 请求头里只挑出需要的两项 */
export function pickCookiePairs(raw: string): string {
  const session = /LEETCODE_SESSION=([^;\n]+)/.exec(raw);
  const csrf = /csrftoken=([^;\n]+)/.exec(raw);
  const parts: string[] = [];
  if (session) parts.push(`LEETCODE_SESSION=${session[1].trim()}`);
  if (csrf) parts.push(`csrftoken=${csrf[1].trim()}`);
  return parts.join("; ");
}

/**
 * 打开登录窗口并轮询 cookie。
 *
 * verify 每轮拿到疑似 session 时被调用一次，返回用户名表示成功（此时关窗收工），
 * 返回 null 表示这个 cookie 还不可用，继续等。
 *
 * 返回 false 表示环境不支持，调用方应降级到手动粘贴。
 */
export async function openEmbeddedLogin(
  verify: (cookie: string) => Promise<string | null>
): Promise<boolean> {
  const remote = getRemote();
  if (!remote) return false;

  const win = new remote.BrowserWindow({
    width: 1000,
    height: 780,
    title: "登录力扣 · 成功后会自己关掉",
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
    },
  });

  const ses = win.webContents.session;
  // 微信 / QQ 等第三方登录会弹新窗口，不放开点不动
  win.webContents.setWindowOpenHandler(() => ({ action: "allow" }));

  let done = false;
  let verifying = false;
  let timer = 0;

  const finish = (): void => {
    if (done) return;
    done = true;
    window.clearInterval(timer);
    try {
      win.destroy();
    } catch {
      /* 用户可能已经自己关掉了 */
    }
  };

  win.on("closed", () => {
    done = true;
    window.clearInterval(timer);
  });

  const tick = async (): Promise<void> => {
    if (done || verifying) return;
    if (win.isDestroyed()) {
      finish();
      return;
    }
    try {
      const cookies = await ses.cookies.get({ url: "https://leetcode.cn" });
      const session = cookies.find((c) => c.name === "LEETCODE_SESSION");
      if (!session || session.value.length < MIN_SESSION_LEN) return;

      verifying = true;
      const username = await verify(buildCookieString(cookies));
      verifying = false;
      if (username) finish();
    } catch {
      verifying = false;
    }
  };

  timer = window.setInterval(() => void tick(), POLL_MS);
  void win.loadURL(LOGIN_URL);
  win.focus();
  return true;
}
