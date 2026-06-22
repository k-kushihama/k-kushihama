import { graphql } from '@octokit/graphql';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type LanguageEdge = {
  size: number;
  node: { name: string; color: string | null };
};

type Repository = {
  name: string;
  languages: { edges: LanguageEdge[] };
};

type Lang = {
  name: string;
  size: number;
  color: string;
  percentage: number;
};

type Theme = {
  text: string;
  textMuted: string;
  border: string;
  track: string;
};

const THEMES: Record<'light' | 'dark', Theme> = {
  light: {
    text: '#1f2328',
    textMuted: '#656d76',
    border: '#d0d7de',
    track: '#eaeef2',
  },
  dark: {
    text: '#e6edf3',
    textMuted: '#7d8590',
    border: '#30363d',
    track: '#21262d',
  },
};

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const DEFAULT_COLOR = '#858585';

async function fetchAllRepos(token: string): Promise<Repository[]> {
  const client = graphql.defaults({
    headers: { authorization: `token ${token}` },
  });

  const repos: Repository[] = [];
  let cursor: string | null = null;

  // ページネーション．100件ずつ取得し，hasNextPageが切れるまで継続
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = (await client(
      `query($cursor: String) {
        viewer {
          repositories(
            first: 100
            after: $cursor
            ownerAffiliations: OWNER
            isFork: false
          ) {
            nodes {
              name
              languages(first: 20, orderBy: {field: SIZE, direction: DESC}) {
                edges {
                  size
                  node { name color }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { cursor }
    )) as {
      viewer: {
        repositories: {
          nodes: Repository[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };

    const page = data.viewer.repositories;
    repos.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return repos;
}

function aggregate(repos: Repository[], excludeLangs: Set<string>): Lang[] {
  const m = new Map<string, { size: number; color: string }>();

  for (const repo of repos) {
    for (const e of repo.languages.edges) {
      if (excludeLangs.has(e.node.name)) continue;
      const color = e.node.color ?? DEFAULT_COLOR;
      const cur = m.get(e.node.name);
      if (cur) {
        cur.size += e.size;
      } else {
        m.set(e.node.name, { size: e.size, color });
      }
    }
  }

  let total = 0;
  const arr: Lang[] = [];
  for (const [name, v] of m.entries()) {
    arr.push({ name, size: v.size, color: v.color, percentage: 0 });
    total += v.size;
  }
  for (const a of arr) {
    a.percentage = total === 0 ? 0 : (a.size / total) * 100;
  }
  arr.sort((a, b) => b.size - a.size);
  return arr;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function generateSVG(
  langs: Lang[],
  theme: Theme,
  opts: { topN: number; width: number; title: string }
): string {
  const top = langs.slice(0, opts.topN);
  const W = opts.width;
  const PAD = 24;
  const titleY = PAD + 14;
  const barY = titleY + 16;
  const barH = 10;
  const barRadius = barH / 2;
  const innerW = W - PAD * 2;
  const cols = 2;
  const colW = innerW / cols;
  const rowH = 24;
  const rows = Math.ceil(top.length / cols);
  const legendStartY = barY + barH + 24;
  const H = legendStartY + rows * rowH + PAD - 8;

  // 積み上げバーのセグメント．topN内での比率で全幅を埋める
  const topTotal = top.reduce((s, l) => s + l.size, 0);
  let x = PAD;
  const segs: string[] = [];
  for (const l of top) {
    const w = topTotal === 0 ? 0 : (l.size / topTotal) * innerW;
    segs.push(
      `<rect x="${x.toFixed(2)}" y="${barY}" width="${w.toFixed(2)}" height="${barH}" fill="${l.color}"/>`
    );
    x += w;
  }

  // 凡例を2列グリッドで配置
  const legendItems: string[] = [];
  for (let i = 0; i < top.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const lx = PAD + col * colW;
    const ly = legendStartY + row * rowH;
    const l = top[i];
    legendItems.push(
      `<g transform="translate(${lx} ${ly})">` +
        `<circle cx="6" cy="6" r="5" fill="${l.color}"/>` +
        `<text x="20" y="10" fill="${theme.text}" font-size="13" font-family="${FONT_STACK}">${escapeXml(l.name)}</text>` +
        `<text x="${(colW - 12).toFixed(2)}" y="10" text-anchor="end" fill="${theme.textMuted}" font-size="13" font-family="${FONT_STACK}">${l.percentage.toFixed(1)}%</text>` +
        `</g>`
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeXml(opts.title)}">
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="8" fill="none" stroke="${theme.border}"/>
  <text x="${PAD}" y="${titleY}" fill="${theme.text}" font-size="16" font-weight="600" font-family="${FONT_STACK}">${escapeXml(opts.title)}</text>
  <rect x="${PAD}" y="${barY}" width="${innerW}" height="${barH}" rx="${barRadius}" fill="${theme.track}"/>
  <g clip-path="url(#clip)">${segs.join('')}</g>
  <defs>
    <clipPath id="clip">
      <rect x="${PAD}" y="${barY}" width="${innerW}" height="${barH}" rx="${barRadius}"/>
    </clipPath>
  </defs>
  ${legendItems.join('')}
</svg>`;
}

function num(v: string | undefined, d: number): number {
  if (!v) return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

async function main() {
  const token = process.env.GH_TOKEN;
  if (!token) {
    console.error('GH_TOKEN environment variable is required');
    process.exit(1);
  }

  const topN = num(process.env.TOP_N, 8);
  const width = num(process.env.CARD_WIDTH, 500);
  const title = process.env.CARD_TITLE ?? 'Most Used Languages';
  const excludeLangs = new Set(
    (process.env.EXCLUDE_LANGS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const outDir = process.env.OUT_DIR ?? './generated';

  console.log('Fetching repositories from GitHub GraphQL API...');
  const repos = await fetchAllRepos(token);
  console.log(`Fetched ${repos.length} owned, non-fork repositories.`);

  const langs = aggregate(repos, excludeLangs);
  console.log(`Aggregated ${langs.length} unique languages.`);

  await mkdir(outDir, { recursive: true });

  const lightSVG = generateSVG(langs, THEMES.light, { topN, width, title });
  const darkSVG = generateSVG(langs, THEMES.dark, { topN, width, title });

  await writeFile(join(outDir, 'top-langs-light.svg'), lightSVG);
  await writeFile(join(outDir, 'top-langs-dark.svg'), darkSVG);

  console.log('');
  console.log('Generated files:');
  console.log(`  ${join(outDir, 'top-langs-light.svg')}`);
  console.log(`  ${join(outDir, 'top-langs-dark.svg')}`);
  console.log('');
  console.log('Top languages:');
  for (const l of langs.slice(0, topN)) {
    console.log(`  ${l.name.padEnd(20)} ${l.percentage.toFixed(1).padStart(5)}%`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
