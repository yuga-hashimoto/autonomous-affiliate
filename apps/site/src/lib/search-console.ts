/**
 * Google Search Console ownership (HTML tag method). Pure helper, free of
 * `astro:*` imports so vitest can test it; BaseLayout writes the meta tag.
 *
 * Like the GA4 tag, the tag is opt-in by build configuration: without a valid
 * GSC_VERIFICATION_TOKEN no meta tag is written.
 */

const VERIFICATION_TOKEN = /^[A-Za-z0-9_-]{20,100}$/;

/**
 * The token from Search Console's `<meta name="google-site-verification">`
 * snippet, or undefined. Strict on purpose: the value ends up in an HTML
 * attribute, so anything unexpected disables the tag rather than being escaped.
 */
export function siteVerificationFrom(raw: string | undefined): string | undefined {
  const token = raw?.trim();
  return token !== undefined && VERIFICATION_TOKEN.test(token) ? token : undefined;
}
