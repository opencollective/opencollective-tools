require('../env');

const fs = require('fs');
const path = require('path');

const { Command } = require('commander');
const { request, gql } = require('graphql-request');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

const endpoint = process.env.PERSONAL_TOKEN
  ? `${process.env.API_URL}/graphql?personalToken=${process.env.PERSONAL_TOKEN}`
  : `${process.env.API_URL}/graphql/${process.env.API_KEY}`;

const PAGE_SIZE = 100;

const updatesQuery = gql`
  query Updates($slug: String!, $limit: Int!, $offset: Int!) {
    account(slug: $slug) {
      slug
      updates(limit: $limit, offset: $offset, onlyPublishedUpdates: true) {
        totalCount
        nodes {
          slug
          title
          summary
          html
          tags
          publishedAt
          createdAt
          fromAccount {
            name
          }
        }
      }
    }
  }
`;

const fetchAllUpdates = async (slug) => {
  const updates = [];
  let totalCount = Infinity;
  while (updates.length < totalCount) {
    const result = await request(endpoint, updatesQuery, { slug, limit: PAGE_SIZE, offset: updates.length });
    if (!result.account) {
      throw new Error(`Account "${slug}" not found`);
    }
    const { nodes, totalCount: total } = result.account.updates;
    totalCount = total;
    if (!nodes.length) {
      break;
    }
    updates.push(...nodes);
  }
  return { updates, totalCount };
};

const buildTurndown = () => {
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  turndown.use(gfm);
  // Keep embeds (videos etc.) instead of silently dropping them
  turndown.keep(['iframe', 'video', 'audio']);
  return turndown;
};

const yamlString = (value) => JSON.stringify(value ?? '');

const toFrontMatter = (update, slug) => {
  const date = update.publishedAt || update.createdAt;
  return [
    '---',
    `title: ${yamlString(update.title)}`,
    `slug: ${yamlString(update.slug)}`,
    `date: ${yamlString(date)}`,
    `author: ${yamlString(update.fromAccount?.name)}`,
    `tags: [${(update.tags || []).map(yamlString).join(', ')}]`,
    `original_url: ${yamlString(`https://opencollective.com/${slug}/updates/${update.slug}`)}`,
    '---',
    '',
  ].join('\n');
};

const main = async (options) => {
  if (process.env.API_URL.includes('staging')) {
    console.warn(
      `Warning: API_URL is ${process.env.API_URL}. Set API_URL=https://api.opencollective.com for production.`,
    );
  }

  const { slug } = options;
  const outDir = path.resolve(options.out);
  fs.mkdirSync(outDir, { recursive: true });

  const { updates, totalCount } = await fetchAllUpdates(slug);
  console.log(`Fetched ${updates.length}/${totalCount} published updates from ${slug}`);

  const turndown = buildTurndown();
  const index = [];
  for (const update of updates) {
    const date = (update.publishedAt || update.createdAt).slice(0, 10);
    const filename = `${date}-${update.slug}.md`;
    // Drop trailing whitespace left by <br> tags and collapse the resulting runs of blank lines
    const body = turndown
      .turndown(update.html || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    fs.writeFileSync(path.join(outDir, filename), `${toFrontMatter(update, slug)}\n# ${update.title}\n\n${body}\n`);
    index.push(`- ${date} — [${update.title}](${filename})`);
  }

  fs.writeFileSync(path.join(outDir, 'index.md'), `# ${slug} updates\n\n${index.join('\n')}\n`);
  console.log(`Wrote ${updates.length} files to ${outDir}`);
};

const program = new Command();
program
  .description('Export all published updates of a collective to Markdown files')
  .option('--slug <slug>', 'Account slug', 'opensource')
  .option('--out <dir>', 'Output directory', path.join(__dirname, '..', '..', 'osc-updates'))
  .action((options) => {
    main(options).catch((e) => {
      console.error(e);
      process.exit(1);
    });
  });

program.parse();
