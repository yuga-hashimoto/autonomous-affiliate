export class AllowlistViolationError extends Error {
  constructor(
    public readonly url: string,
    public readonly host: string,
  ) {
    super(`source host "${host}" is not in the allowlist: ${url}`);
    this.name = "AllowlistViolationError";
  }
}

/**
 * Enforces policy.security.allowed_source_domains. An empty allowlist blocks
 * every host (fail closed). Subdomains of an allowed host are allowed.
 */
export class DomainAllowlist {
  constructor(private readonly allowedDomains: readonly string[]) {}

  includes(host: string): boolean {
    const normalized = host.toLowerCase().replace(/:\d+$/, "");
    for (const domain of this.allowedDomains) {
      const d = domain.toLowerCase();
      if (normalized === d || normalized.endsWith(`.${d}`)) return true;
    }
    return false;
  }

  assertAllowed(url: string): void {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new AllowlistViolationError(url, "(unparseable URL)");
    }
    if (!this.includes(host)) {
      throw new AllowlistViolationError(url, host);
    }
  }
}
