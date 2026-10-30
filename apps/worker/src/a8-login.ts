import type { Page } from "playwright";

/**
 * Login check for the A8.net media console (media-console.a8.net).
 *
 * A8 has no API for program search, application, link retrieval or URL
 * submission, so unattended A8 work has to go through the console in a browser.
 * This module only answers the first question: can a CI runner log in with the
 * owner's own credentials, or does A8 stop it with a CAPTCHA / extra
 * verification? It makes a single attempt, never retries a rejection (to avoid
 * locking the account) and prints nothing but a short, non-sensitive result,
 * because the repository and its Actions logs are public.
 */

export const CONSOLE_ORIGIN = "https://media-console.a8.net";
export const A8_LOGIN_URL = `${CONSOLE_ORIGIN}/common/re-authentication`;
const HOME_URL = `${CONSOLE_ORIGIN}/home`;
const PARTNERED_LIST_PATH = "/program/list/partnered";
const NAVIGATION_TIMEOUT_MS = 30_000;

export type A8Outcome = "logged_in" | "challenge" | "rejected" | "unknown";

export interface A8PageSnapshot {
  url: string;
  title: string;
  hasPasswordInput: boolean;
  /** A CAPTCHA widget (reCAPTCHA, hCaptcha, Turnstile) is on the page. */
  hasCaptcha: boolean;
  /** Visible text of the page. */
  bodyText: string;
  /** Visible text of the form's error elements. */
  errorText: string;
  /** Visible text of the login form's own message area ("ログインしてください。" before any attempt). */
  noticeText: string;
}

export interface A8Credentials {
  loginId: string;
  password: string;
}

export interface A8SmokeResult {
  outcome: A8Outcome;
  /** Path only: a query string could carry a token. */
  finalPath: string;
  title: string;
  loginPageStatus?: number;
  /** Whether a member-only page (the partnered programs list) opened after login. */
  sessionUsable?: boolean;
  /** What the login form said, redacted and shortened. Present only on a failure. */
  message?: string;
  hint?: string;
}

const CHALLENGE_PATTERNS = [
  /認証コード/,
  /確認コード/,
  /ワンタイム/,
  /画像認証/,
  /ロボットではありません/,
  /CAPTCHA/i,
  /新しい(端末|デバイス|ブラウザ)/,
];
/** What the form says before any attempt. The page's static notes also contain words like "ログインできません", so only this area counts. */
const LOGIN_PROMPT = "ログインしてください。";
const MESSAGE_MAX_LENGTH = 120;
const LOGIN_PATH = /^\/(common\/re-authentication|login)(\/|$)/;
const HOME_PATH = /^\/home(\/|$)/;

function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

export function safePath(raw: string): string {
  const url = parseUrl(raw);
  return url ? url.pathname : "(invalid url)";
}

/** A message from the login form other than the standard prompt, or "" when it said nothing new. */
function formMessage(snapshot: A8PageSnapshot): string {
  const errorText = snapshot.errorText.trim();
  if (errorText) return errorText;
  const noticeText = snapshot.noticeText.trim();
  return noticeText === LOGIN_PROMPT ? "" : noticeText;
}

/**
 * Decides what a page after a login attempt means. The home page counts as
 * logged in only on A8's own host and without a password field; a verification
 * step is recognised before a rejection, and anything unrecognised is unknown
 * rather than a guess.
 */
export function classifyA8Page(snapshot: A8PageSnapshot): A8Outcome {
  const url = parseUrl(snapshot.url);
  if (!url || url.origin !== CONSOLE_ORIGIN) return "unknown";
  if (snapshot.hasCaptcha) return "challenge";
  if (HOME_PATH.test(url.pathname) && !snapshot.hasPasswordInput) return "logged_in";
  if (CHALLENGE_PATTERNS.some((pattern) => pattern.test(snapshot.bodyText))) return "challenge";
  const onLoginForm = LOGIN_PATH.test(url.pathname) || snapshot.hasPasswordInput;
  if (onLoginForm) {
    return formMessage(snapshot) ? "rejected" : "unknown";
  }
  return "unknown";
}

export function credentialsFromEnv(env: NodeJS.ProcessEnv): A8Credentials {
  const loginId = env.A8_LOGIN_ID?.trim();
  const password = env.A8_LOGIN_PASSWORD?.trim();
  if (!loginId) throw new Error("A8_LOGIN_ID is not set");
  if (!password) throw new Error("A8_LOGIN_PASSWORD is not set");
  return { loginId, password };
}

/**
 * The runner already has Google Chrome, so CI sets A8_BROWSER_CHANNEL=chrome and
 * downloads nothing (installing Playwright's browser with system packages
 * stalled on a slow mirror once and timed the job out). Locally the default
 * Chromium is used. Only "chrome" is accepted, never free text.
 */
export function browserLaunchOptions(env: NodeJS.ProcessEnv): { headless: true; channel?: "chrome" } {
  const channel = env.A8_BROWSER_CHANNEL?.trim();
  if (!channel) return { headless: true };
  if (channel !== "chrome") throw new Error('A8_BROWSER_CHANNEL must be "chrome" or unset');
  return { headless: true, channel };
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((current, secret) => current.split(secret).join("[redacted]"), text);
}

/**
 * An error of console work as one line for a public log: the first line only, secrets hidden, and
 * the query of any link and any long number (ids) masked, since a browser error can quote the page it was on.
 */
export function publicErrorLine(message: string, secrets: readonly string[]): string {
  const line = redactSecrets(message, secrets).split("\n")[0] ?? "";
  const masked = line.replace(/\?[^\s"')]*/g, "?…").replace(/\d{6,}/g, "#").trim();
  return masked || "A8 console work failed";
}

export function describeA8Failure(outcome: Exclude<A8Outcome, "logged_in">): string {
  switch (outcome) {
    case "challenge":
      return "A8が追加の認証(CAPTCHAまたはメール/端末の確認)を求めた。CIからの自動ログインは通らないため、Macの定期実行に切り替える。";
    case "rejected":
      return "A8がIDまたはパスワードを受け付けなかった。ロックを避けるため再試行しない。secretの値を確認してから手動で再実行する。";
    case "unknown":
      return "ログイン後のページを判定できなかった。ブロックページや仕様変更の可能性がある。finalPathとtitleで確認する。";
  }
}

/** Runs in the page. A string, because this project's TypeScript config has no DOM types. */
const READ_PAGE_STATE = `(() => {
  const visibleText = (element) => (element.innerText || "").trim();
  const captcha = document.querySelector(
    'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile',
  );
  return {
    hasPasswordInput: document.querySelector("input[type=password]") !== null,
    hasCaptcha: captcha !== null,
    bodyText: document.body ? visibleText(document.body) : "",
    errorText: Array.from(document.querySelectorAll(".txtError, .messageError, .alertError"))
      .map(visibleText)
      .filter((text) => text.length > 0)
      .join(" "),
    noticeText: Array.from(document.querySelectorAll('form[name="asLogin"] .messageNotice, form[name="asLogin"] .messageError'))
      .map(visibleText)
      .filter((text) => text.length > 0)
      .join(" "),
  };
})()`;

type A8PageState = Pick<A8PageSnapshot, "hasPasswordInput" | "hasCaptcha" | "bodyText" | "errorText" | "noticeText">;

export async function snapshotOf(page: Page): Promise<A8PageSnapshot> {
  const state = (await page.evaluate(READ_PAGE_STATE)) as A8PageState;
  return { ...state, url: page.url(), title: await page.title() };
}

function resultOf(
  outcome: A8Outcome,
  snapshot: A8PageSnapshot,
  credentials: A8Credentials,
  extra: Pick<A8SmokeResult, "loginPageStatus" | "sessionUsable">,
): A8SmokeResult {
  const message = formMessage(snapshot);
  return {
    outcome,
    finalPath: safePath(snapshot.url),
    title: snapshot.title,
    ...extra,
    ...(outcome === "logged_in"
      ? {}
      : {
          ...(message
            ? { message: redactSecrets(message, [credentials.loginId, credentials.password]).slice(0, MESSAGE_MAX_LENGTH) }
            : {}),
          hint: describeA8Failure(outcome),
        }),
  };
}

async function sessionOpensMemberPage(page: Page): Promise<boolean> {
  await page.goto(`${CONSOLE_ORIGIN}${PARTNERED_LIST_PATH}`, { waitUntil: "domcontentloaded" });
  const snapshot = await snapshotOf(page);
  return safePath(snapshot.url) === PARTNERED_LIST_PATH && !snapshot.hasPasswordInput;
}

async function attemptLogin(page: Page, credentials: A8Credentials): Promise<A8SmokeResult> {
  const loginResponse = await page.goto(A8_LOGIN_URL, { waitUntil: "domcontentloaded" });
  const loginPageStatus = loginResponse?.status();
  const before = await snapshotOf(page);
  if (before.hasCaptcha) return resultOf("challenge", before, credentials, { loginPageStatus });

  await page.fill("#mediaLoginName", credentials.loginId);
  await page.fill("#mediaLoginPassword", credentials.password);
  // The form POST is a full navigation. Waiting for it to commit (after any redirect) means the
  // snapshot below is of the page A8 answered with, not of the login form we just left.
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }),
    page.click("form[name=asLogin] button[type=submit]"),
  ]);

  const after = await snapshotOf(page);
  const firstOutcome = classifyA8Page(after);
  if (firstOutcome === "challenge" || firstOutcome === "rejected") {
    return resultOf(firstOutcome, after, credentials, { loginPageStatus });
  }

  // Confirm with an explicit visit: logged in means /home opens without sending us back to the form.
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  const home = await snapshotOf(page);
  const outcome = classifyA8Page(home);
  if (outcome !== "logged_in") return resultOf(outcome, home, credentials, { loginPageStatus });
  return resultOf("logged_in", home, credentials, { loginPageStatus, sessionUsable: await sessionOpensMemberPage(page) });
}

export interface A8SessionResult<T> {
  login: A8SmokeResult;
  /** Present only when the login succeeded and `work` finished. */
  value?: T;
}

/**
 * Logs in once, runs `work` on the logged-in page and always closes the browser.
 * A login that fails (verification, rejection, anything unknown) is returned as
 * data and `work` is not run. Errors from `work` are redacted before they leave.
 */
export async function withA8Session<T>(
  env: NodeJS.ProcessEnv,
  work: (page: Page) => Promise<T>,
): Promise<A8SessionResult<T>> {
  const credentials = credentialsFromEnv(env);
  const secrets = [credentials.loginId, credentials.password];
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(browserLaunchOptions(env));
  try {
    const context = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo" });
    const page = await context.newPage();
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    const login = await attemptLogin(page, credentials);
    if (login.outcome !== "logged_in") return { login };
    return { login, value: await work(page) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(publicErrorLine(message, secrets));
  } finally {
    await browser.close();
  }
}

/** One login attempt from this machine; the caller decides what a non-"logged_in" outcome means. */
export async function runA8LoginSmoke(env: NodeJS.ProcessEnv): Promise<A8SmokeResult> {
  return (await withA8Session(env, async () => undefined)).login;
}
