import { cleanRedditText } from "@/lib/sentiment/reddit/cleanRedditText";

export type RedditPost = {
  symbol: string;
  subreddit: string;
  postId: string;
  url: string | null;
  title: string | null;
  body: string;
  score: number | null;
  numComments: number | null;
  createdUtc: Date | null;
  cleanedText: string;
};

export function redditConfigured() {
  return Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET && process.env.REDDIT_USER_AGENT);
}

async function redditAccessToken() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Reddit sentiment unavailable. Configure Reddit API credentials to enable this feature.");
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": process.env.REDDIT_USER_AGENT ?? "RiskGateLocalResearch/1.0"
    },
    body: new URLSearchParams({ grant_type: "client_credentials" })
  });

  if (!response.ok) {
    throw new Error(`Reddit auth failed: ${response.status}`);
  }

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Reddit auth did not return an access token.");
  return data.access_token;
}

function postUrl(permalink: unknown) {
  if (typeof permalink !== "string" || !permalink) return null;
  return permalink.startsWith("http") ? permalink : `https://www.reddit.com${permalink}`;
}

function normalizePost(symbol: string, subreddit: string, raw: Record<string, unknown>): RedditPost | null {
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!id) return null;
  const title = typeof raw.title === "string" ? raw.title : null;
  const selftext = typeof raw.selftext === "string" ? raw.selftext : "";
  const body = [title, selftext].filter(Boolean).join("\n\n");
  const cleanedText = cleanRedditText(body);
  if (cleanedText.length < 20) return null;
  const createdUtc = typeof raw.created_utc === "number" ? new Date(raw.created_utc * 1000) : null;

  return {
    symbol: symbol.toUpperCase(),
    subreddit,
    postId: id,
    url: postUrl(raw.permalink),
    title,
    body,
    score: typeof raw.score === "number" ? raw.score : null,
    numComments: typeof raw.num_comments === "number" ? raw.num_comments : null,
    createdUtc,
    cleanedText
  };
}

export function buildRedditSearchQuery(input: {
  symbol: string;
  companyName?: string | null;
  catalyst?: string | null;
}) {
  const terms = [
    input.symbol.toUpperCase(),
    input.companyName,
    ...(input.catalyst ?? "")
      .split(/[^A-Za-z0-9$]+/)
      .filter((term) => term.length >= 3)
      .slice(0, 4),
    "earnings",
    "guidance",
    "upgrade",
    "downgrade",
    "margins",
    "demand"
  ].filter((term): term is string => Boolean(term));

  return Array.from(new Set(terms)).join(" OR ");
}

export async function fetchRedditPosts(input: {
  symbol: string;
  companyName?: string | null;
  catalyst?: string | null;
  subreddits: string[];
  maxPostsPerSubreddit?: number;
}) {
  if (!redditConfigured()) {
    throw new Error("Reddit sentiment unavailable. Configure Reddit API credentials to enable this feature.");
  }

  const token = await redditAccessToken();
  const query = buildRedditSearchQuery(input);
  const maxPosts = Math.max(Math.min(input.maxPostsPerSubreddit ?? 10, 25), 1);
  const posts: RedditPost[] = [];

  for (const subreddit of input.subreddits) {
    const params = new URLSearchParams({
      q: query,
      restrict_sr: "true",
      sort: "new",
      t: "month",
      limit: String(maxPosts)
    });
    const response = await fetch(`https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/search?${params.toString()}`, {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": process.env.REDDIT_USER_AGENT ?? "RiskGateLocalResearch/1.0"
      }
    });

    if (!response.ok) continue;
    const data = (await response.json()) as {
      data?: {
        children?: Array<{ data?: Record<string, unknown> }>;
      };
    };
    for (const child of data.data?.children ?? []) {
      const post = child.data ? normalizePost(input.symbol, subreddit, child.data) : null;
      if (post) posts.push(post);
    }
  }

  return posts;
}
