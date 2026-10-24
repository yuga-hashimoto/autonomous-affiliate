/**
 * B019/B022: distribution adapters. All default to disabled and report
 * SKIPPED unless an official API grant has been recorded. No unofficial
 * posting paths exist (note/Qiita/Zenn auto-posting is out of scope by policy).
 */
export interface PublishPostRequest {
  pageId: string;
  title: string;
  summary: string;
  url: string;
  /** Ad disclosure text required on every medium (docs/06). */
  disclosure: string;
}

export type PublishOutcome =
  | { status: "SKIPPED"; reason: string }
  | { status: "PUBLISHED"; externalId: string };

export interface DistributionAdapter {
  readonly channel: "youtube" | "x" | "email";
  readonly enabled: boolean;
  publish(post: PublishPostRequest): Promise<PublishOutcome>;
}

export class DisabledDistributionAdapter implements DistributionAdapter {
  constructor(
    public readonly channel: DistributionAdapter["channel"],
    private readonly reason = "official API permission not confirmed; distribution disabled by policy",
  ) {}

  readonly enabled = false;

  async publish(_post: PublishPostRequest): Promise<PublishOutcome> {
    return { status: "SKIPPED", reason: this.reason };
  }
}

/** Only usable when a real API grant exists; the worker wires credentials in. */
export class ApiGrantedDistributionAdapter implements DistributionAdapter {
  readonly enabled = true;

  constructor(
    public readonly channel: DistributionAdapter["channel"],
    private readonly api: (post: PublishPostRequest) => Promise<{ id: string }>,
  ) {}

  async publish(post: PublishPostRequest): Promise<PublishOutcome> {
    if (!post.disclosure.trim()) {
      return { status: "SKIPPED", reason: "missing ad disclosure" };
    }
    const { id } = await this.api(post);
    return { status: "PUBLISHED", externalId: id };
  }
}
