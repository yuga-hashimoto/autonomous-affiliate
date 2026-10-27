import { describe, expect, it } from "vitest";
import {
  A8_LOGIN_URL,
  browserLaunchOptions,
  classifyA8Page,
  credentialsFromEnv,
  describeA8Failure,
  redactSecrets,
  safePath,
  type A8PageSnapshot,
} from "../../apps/worker/src/a8-login.js";

function snapshot(overrides: Partial<A8PageSnapshot>): A8PageSnapshot {
  return {
    url: "https://media-console.a8.net/home",
    title: "ホーム | A8.net",
    hasPasswordInput: false,
    hasCaptcha: false,
    bodyText: "ようこそ 参加中プログラム 成果状況",
    errorText: "",
    noticeText: "",
    ...overrides,
  };
}

const LOGIN_FORM_URL = "https://media-console.a8.net/common/re-authentication?messageType=login_required";
// The login page's static notes, which exist before anyone has tried to log in.
const STATIC_NOTES = "Cookieを許可する設定になっていないとログインできません。 打ち間違えていないかご確認下さい。";

describe("classifyA8Page", () => {
  it("treats the home page without a password field as logged in", () => {
    expect(classifyA8Page(snapshot({}))).toBe("logged_in");
  });

  it("treats the login form with an error message as rejected", () => {
    const page = snapshot({
      url: "https://media-console.a8.net/common/re-authentication?messageType=login_required",
      hasPasswordInput: true,
      errorText: "ログインIDまたはパスワードが正しくありません。",
    });
    expect(classifyA8Page(page)).toBe("rejected");
  });

  it("treats a message in the login form other than the standard prompt as a rejection", () => {
    const page = snapshot({
      url: LOGIN_FORM_URL,
      hasPasswordInput: true,
      noticeText: "アカウントがロックされています。",
    });
    expect(classifyA8Page(page)).toBe("rejected");
  });

  it("does not take the untouched login page for a rejection, even though its static notes say 'cannot log in'", () => {
    const page = snapshot({
      url: LOGIN_FORM_URL,
      hasPasswordInput: true,
      noticeText: "ログインしてください。",
      bodyText: `ログインしてください。 ${STATIC_NOTES}`,
    });
    expect(classifyA8Page(page)).toBe("unknown");
  });

  it("does not call a login form without any message a rejection", () => {
    const page = snapshot({
      url: "https://media-console.a8.net/common/re-authentication",
      hasPasswordInput: true,
    });
    expect(classifyA8Page(page)).toBe("unknown");
  });

  it("detects a CAPTCHA widget on the login form", () => {
    const page = snapshot({
      url: "https://media-console.a8.net/common/re-authentication",
      hasPasswordInput: true,
      hasCaptcha: true,
    });
    expect(classifyA8Page(page)).toBe("challenge");
  });

  it.each(["認証コードを入力してください", "メールに届いた確認コード", "画像認証を行ってください", "新しい端末からのログインです"])(
    "detects an extra verification step (%s)",
    (text) => {
      const page = snapshot({ url: "https://media-console.a8.net/common/verify", bodyText: text });
      expect(classifyA8Page(page)).toBe("challenge");
    },
  );

  it("does not let words on the home page turn a logged-in session into a challenge", () => {
    const page = snapshot({ bodyText: "アカウント認証コード通知設定 メール確認" });
    expect(classifyA8Page(page)).toBe("logged_in");
  });

  it("is unknown for a page on another host, so a redirect elsewhere is never trusted", () => {
    expect(classifyA8Page(snapshot({ url: "https://example.com/home" }))).toBe("unknown");
    expect(classifyA8Page(snapshot({ url: "https://media-console.a8.net.evil.example/home" }))).toBe("unknown");
  });

  it("is unknown for a blocked or error page", () => {
    expect(classifyA8Page(snapshot({ url: "https://media-console.a8.net/error", bodyText: "Access Denied" }))).toBe(
      "unknown",
    );
  });

  it("does not treat a lookalike path as the home page", () => {
    expect(classifyA8Page(snapshot({ url: "https://media-console.a8.net/homepage-fake" }))).toBe("unknown");
  });
});

describe("safePath", () => {
  it("keeps only the path, never the query or fragment that could carry a token", () => {
    expect(safePath("https://media-console.a8.net/home?token=abc#frag")).toBe("/home");
  });

  it("returns a placeholder for something that is not a URL", () => {
    expect(safePath("not a url")).toBe("(invalid url)");
  });
});

describe("credentialsFromEnv", () => {
  it("reads the login id and password", () => {
    expect(credentialsFromEnv({ A8_LOGIN_ID: "id-1", A8_LOGIN_PASSWORD: "pw-1" })).toEqual({
      loginId: "id-1",
      password: "pw-1",
    });
  });

  it("fails without naming any value when one is missing or blank", () => {
    expect(() => credentialsFromEnv({ A8_LOGIN_PASSWORD: "pw-1" })).toThrow(/A8_LOGIN_ID/);
    expect(() => credentialsFromEnv({ A8_LOGIN_ID: "id-1", A8_LOGIN_PASSWORD: "  " })).toThrow(/A8_LOGIN_PASSWORD/);
  });
});

describe("redactSecrets", () => {
  it("replaces every secret and ignores empty ones", () => {
    const text = "fill id-1 then pw-1 failed; id-1 again";
    expect(redactSecrets(text, ["id-1", "pw-1", ""])).toBe("fill [redacted] then [redacted] failed; [redacted] again");
  });
});

describe("describeA8Failure", () => {
  it("gives a different next step for each outcome", () => {
    const hints = (["challenge", "rejected", "unknown"] as const).map(describeA8Failure);
    expect(new Set(hints).size).toBe(3);
    expect(describeA8Failure("challenge")).toMatch(/CAPTCHA|認証/);
    expect(describeA8Failure("rejected")).toMatch(/再試行しない/);
  });
});

describe("browserLaunchOptions", () => {
  it("launches Playwright's own headless Chromium by default", () => {
    expect(browserLaunchOptions({})).toEqual({ headless: true });
  });

  it("can use the Google Chrome already installed on the runner, so nothing is downloaded", () => {
    expect(browserLaunchOptions({ A8_BROWSER_CHANNEL: "chrome" })).toEqual({ headless: true, channel: "chrome" });
  });

  it("refuses any other channel instead of passing arbitrary text to the launcher", () => {
    expect(() => browserLaunchOptions({ A8_BROWSER_CHANNEL: "msedge" })).toThrow(/A8_BROWSER_CHANNEL/);
    expect(() => browserLaunchOptions({ A8_BROWSER_CHANNEL: "chrome; rm -rf /" })).toThrow(/A8_BROWSER_CHANNEL/);
  });
});

describe("login target", () => {
  it("is the console's own login page", () => {
    expect(A8_LOGIN_URL).toBe("https://media-console.a8.net/common/re-authentication");
  });
});
