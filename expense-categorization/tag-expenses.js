#!/usr/bin/env node

/**
 * Expense Tagging Tool
 *
 * Fetches untagged expenses for a given Open Collective account,
 * proposes tags based on similar previously tagged expenses,
 * and interactively asks for user confirmation.
 */

require('../env');

const { Command } = require('commander');
const { gql, request } = require('graphql-request');
const { select, confirm, input } = require('@inquirer/prompts');
const { pRateLimit } = require('p-ratelimit');

// Rate limiter: 60 requests per minute (OC API allows 100)
const rateLimiter = pRateLimit({
  interval: 60 * 1000,
  rate: 60,
});

const rateLimitedRequest = (endpoint, query, variables) => {
  return rateLimiter(() => request(endpoint, query, variables));
};

// GraphQL endpoint
const getEndpoint = () => {
  return process.env.PERSONAL_TOKEN
    ? `${process.env.API_URL}/graphql?personalToken=${process.env.PERSONAL_TOKEN}`
    : `${process.env.API_URL}/graphql/${process.env.API_KEY}`;
};

// ============================================================================
// GraphQL Queries
// ============================================================================

const accountQuery = gql`
  query Account($slug: String!) {
    account(slug: $slug) {
      id
      slug
      name
      type
    }
  }
`;

const expensesQuery = gql`
  query Expenses($slug: String!, $limit: Int!, $offset: Int!, $status: [ExpenseStatusFilter!]) {
    expenses(
      account: { slug: $slug }
      limit: $limit
      offset: $offset
      status: $status
      orderBy: { field: CREATED_AT, direction: DESC }
    ) {
      totalCount
      nodes {
        id
        legacyId
        description
        longDescription
        type
        status
        createdAt
        currency
        amount
        amountV2 {
          value
          currency
        }
        payee {
          id
          slug
          name
          type
        }
        payoutMethod {
          id
          type
          name
        }
        virtualCard {
          id
          name
          last4
        }
        accountingCategory {
          id
          code
          name
          friendlyName
        }
        tags
        items {
          id
          description
          amount
        }
      }
    }
  }
`;

const editExpenseMutation = gql`
  mutation EditExpense($expense: ExpenseUpdateInput!) {
    editExpense(expense: $expense) {
      id
      legacyId
      tags
    }
  }
`;

// ============================================================================
// Similarity Algorithm
// ============================================================================

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1, str2) {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();

  const len1 = s1.length;
  const len2 = s2.length;

  const matrix = Array(len1 + 1)
    .fill(null)
    .map(() => Array(len2 + 1).fill(null));

  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }

  return matrix[len1][len2];
}

/**
 * Calculate string similarity (0 to 1)
 */
function stringSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(str1, str2) / maxLen;
}

/**
 * Extract keywords from a string
 */
function extractKeywords(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

/**
 * Calculate keyword overlap score
 */
function keywordOverlap(text1, text2) {
  const keywords1 = new Set(extractKeywords(text1));
  const keywords2 = new Set(extractKeywords(text2));

  if (keywords1.size === 0 || keywords2.size === 0) return 0;

  const intersection = [...keywords1].filter((k) => keywords2.has(k)).length;
  const union = new Set([...keywords1, ...keywords2]).size;

  return intersection / union;
}

/**
 * Calculate amount similarity (0 to 1)
 */
function amountSimilarity(amount1, amount2) {
  if (amount1 === 0 && amount2 === 0) return 1;
  if (amount1 === 0 || amount2 === 0) return 0;

  const logDiff = Math.abs(Math.log10(amount1) - Math.log10(amount2));
  return Math.exp(-logDiff);
}

/**
 * Calculate overall similarity score between two expenses
 */
function calculateSimilarity(expense1, expense2) {
  // Check virtual card match (strongest signal)
  const hasVirtualCard1 = !!expense1.virtualCard?.id;
  const hasVirtualCard2 = !!expense2.virtualCard?.id;
  const virtualCardMatch = hasVirtualCard1 && hasVirtualCard2 && expense1.virtualCard.id === expense2.virtualCard.id;

  // Description similarity
  const descSim = stringSimilarity(expense1.description, expense2.description);

  // Keyword overlap
  const fullText1 = `${expense1.description} ${expense1.longDescription || ''}`;
  const fullText2 = `${expense2.description} ${expense2.longDescription || ''}`;
  const keywordSim = keywordOverlap(fullText1, fullText2);

  // Combined description score
  const descriptionScore = descSim * 0.6 + keywordSim * 0.4;

  // If same virtual card, that's the strongest signal
  if (virtualCardMatch) {
    return 0.85 + descriptionScore * 0.15;
  }

  // Check if virtual card names match
  const cardName1 = expense1.virtualCard?.name?.toLowerCase() || '';
  const cardName2 = expense2.virtualCard?.name?.toLowerCase() || '';
  const cardNameMatch =
    cardName1 &&
    cardName2 &&
    (cardName1 === cardName2 || cardName1.includes(cardName2) || cardName2.includes(cardName1));

  if (cardNameMatch) {
    return 0.5 + descriptionScore * 0.4;
  }

  // No virtual card match - score based on content similarity
  let score = 0;

  // Same payee is a strong signal
  if (expense1.payee?.slug && expense1.payee.slug === expense2.payee?.slug) {
    score += 0.4;
  } else {
    const payeeSim = stringSimilarity(expense1.payee?.name, expense2.payee?.name);
    if (payeeSim > 0.8) {
      score += 0.3;
    } else {
      score += payeeSim * 0.15;
    }
  }

  // Description similarity
  score += descSim * 0.35;

  // Keyword overlap
  score += keywordSim * 0.2;

  // Amount similarity (minor factor)
  const amt1 = Math.abs(expense1.amountV2?.value || expense1.amount / 100);
  const amt2 = Math.abs(expense2.amountV2?.value || expense2.amount / 100);
  score += amountSimilarity(amt1, amt2) * 0.05;

  return score;
}

/**
 * Find most similar tagged expenses
 */
function findSimilarExpenses(untaggedExpense, taggedExpenses, limit = 5) {
  const similarities = taggedExpenses.map((exp) => ({
    expense: exp,
    score: calculateSimilarity(untaggedExpense, exp),
  }));

  similarities.sort((a, b) => b.score - a.score);

  return similarities.slice(0, limit);
}

/**
 * Normalize description by stripping common prefixes that add no matching value
 */
function normalizeDescription(description) {
  if (!description) return '';
  return description
    .replace(/^Virtual Card charge:\s*/i, '')
    .replace(/^Invoice\s+#?\d+\s*/i, '')
    .trim();
}

/**
 * Check if expense has a strong payee or description match
 */
function hasStrongPayeeOrDescriptionMatch(untaggedExpense, similarExpense) {
  // Exact payee match
  if (untaggedExpense.payee?.slug && untaggedExpense.payee.slug === similarExpense.payee?.slug) {
    return true;
  }

  // Very similar payee name (>80% similarity)
  if (untaggedExpense.payee?.name && similarExpense.payee?.name) {
    const payeeSim = stringSimilarity(untaggedExpense.payee.name, similarExpense.payee.name);
    if (payeeSim > 0.8) {
      return true;
    }
  }

  // Very similar description (>80% similarity) - normalize first to strip common prefixes
  const desc1 = normalizeDescription(untaggedExpense.description);
  const desc2 = normalizeDescription(similarExpense.description);
  if (desc1 && desc2) {
    const descSim = stringSimilarity(desc1, desc2);
    if (descSim > 0.8) {
      return true;
    }
  }

  return false;
}

/**
 * Propose tags based on similar expenses
 * Only proposes tags if there's a strong payee or card match
 */
function proposeTags(untaggedExpense, similarExpenses) {
  if (similarExpenses.length === 0) {
    return { tags: [], confidence: 0, hasStrongMatch: false };
  }

  // Filter to only expenses with strong payee/description matches
  const strongMatches = similarExpenses.filter(({ expense }) =>
    hasStrongPayeeOrDescriptionMatch(untaggedExpense, expense),
  );

  if (strongMatches.length === 0) {
    return { tags: [], confidence: 0, hasStrongMatch: false };
  }

  // Collect all tags weighted by similarity score from strong matches only
  const tagScores = {};

  for (const { expense, score } of strongMatches) {
    const tags = expense.tags || [];
    for (const tag of tags) {
      if (!tagScores[tag]) {
        tagScores[tag] = { scores: [], count: 0 };
      }
      tagScores[tag].scores.push(score);
      tagScores[tag].count++;
    }
  }

  // Calculate weighted score for each tag
  const tagResults = [];
  for (const tag in tagScores) {
    const { scores, count } = tagScores[tag];
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const consistencyBonus = Math.min(0.15, (count - 1) * 0.05);
    const confidence = Math.min(1, avgScore + consistencyBonus);
    tagResults.push({ tag, confidence, count });
  }

  // Sort by confidence
  tagResults.sort((a, b) => b.confidence - a.confidence);

  // Return top tags with confidence >= 0.5 (higher threshold for tags)
  const suggestedTags = tagResults.filter((t) => t.confidence >= 0.5).slice(0, 5);

  return {
    tags: suggestedTags,
    confidence: suggestedTags.length > 0 ? suggestedTags[0].confidence : 0,
    hasStrongMatch: true,
  };
}

// ============================================================================
// Display Helpers
// ============================================================================

function formatCurrency(amount, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
  }).format(amount);
}

function formatExpense(expense, collectiveSlug) {
  const amount = expense.amountV2?.value || expense.amount / 100;
  const currency = expense.amountV2?.currency || expense.currency;
  const date = expense.createdAt
    ? new Date(expense.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : 'N/A';

  const virtualCard = expense.virtualCard
    ? `${expense.virtualCard.name || 'Virtual Card'}${expense.virtualCard.last4 ? ` (****${expense.virtualCard.last4})` : ''}`
    : null;

  const expenseUrl = `https://opencollective.com/${collectiveSlug}/expenses/${expense.legacyId}`;

  return [
    `  ID: ${expense.legacyId}`,
    `  URL: ${expenseUrl}`,
    `  Date: ${date}`,
    `  Description: ${expense.description}`,
    `  Amount: ${formatCurrency(amount, currency)}`,
    `  Type: ${expense.type}`,
    virtualCard ? `  Virtual Card: ${virtualCard}` : null,
    `  Payee: ${expense.payee?.name || expense.payee?.slug || 'N/A'}`,
    expense.accountingCategory
      ? `  Category: ${expense.accountingCategory.friendlyName || expense.accountingCategory.name}`
      : null,
    expense.tags?.length ? `  Tags: ${expense.tags.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatSimilarExpense(item, index) {
  const { expense, score } = item;
  const amount = expense.amountV2?.value || expense.amount / 100;
  const currency = expense.amountV2?.currency || expense.currency;
  const tags = expense.tags?.length ? expense.tags.join(', ') : 'none';

  return [
    `  ${index + 1}. [Score: ${(score * 100).toFixed(1)}%] ${expense.description}`,
    `     ${formatCurrency(amount, currency)} | Tags: ${tags}`,
  ].join('\n');
}

// ============================================================================
// Main Logic
// ============================================================================

async function fetchAllExpenses(slug, endpoint, status = null) {
  const allExpenses = [];
  const limit = 100;
  let offset = 0;
  let totalCount = null;

  console.log(`Fetching expenses for ${slug}...`);

  while (totalCount === null || offset < totalCount) {
    const variables = { slug, limit, offset, status };
    const data = await rateLimitedRequest(endpoint, expensesQuery, variables);

    if (totalCount === null) {
      totalCount = data.expenses.totalCount;
      console.log(`Total expenses: ${totalCount}`);
    }

    allExpenses.push(...data.expenses.nodes);
    offset += limit;

    if (offset < totalCount) {
      process.stdout.write(`  Fetched ${allExpenses.length}/${totalCount}...\r`);
    }
  }

  console.log(`Fetched ${allExpenses.length} expenses.`);
  return allExpenses;
}

async function verifyAccount(slug, endpoint) {
  console.log(`Verifying account ${slug}...`);
  const data = await rateLimitedRequest(endpoint, accountQuery, { slug });

  if (!data.account) {
    throw new Error(`Account not found: ${slug}`);
  }

  console.log(`Account: ${data.account.name} (${data.account.type})`);
  return data.account;
}

async function updateExpenseTags(expenseId, tags, endpoint, dryRun) {
  if (dryRun) {
    console.log(`  [DRY RUN] Would update expense tags to: ${tags.join(', ')}`);
    return { success: true, dryRun: true };
  }

  const variables = {
    expense: {
      id: expenseId,
      tags: tags,
    },
  };

  const result = await rateLimitedRequest(endpoint, editExpenseMutation, variables);
  return { success: true, result: result.editExpense };
}

async function processExpenses(options) {
  const endpoint = getEndpoint();
  const { slug, run: isRun, limit: maxToProcess, minScore, status, autoApprove, showSimilar, after, before } = options;

  // Production safety check
  const isProduction = process.env.API_URL && process.env.API_URL.includes('api.opencollective.com');
  if (isRun && isProduction) {
    console.log('\n⚠️  WARNING: You are about to modify expenses in PRODUCTION! ⚠️');
    console.log(`   API: ${process.env.API_URL}\n`);

    const confirmed = await confirm({
      message: 'Are you sure you want to continue?',
      default: false,
    });

    if (!confirmed) {
      console.log('Operation cancelled.');
      return;
    }
  }

  // Verify account exists
  await verifyAccount(slug, endpoint);

  // Fetch all expenses
  const statusFilter = status ? status.toUpperCase().split(',') : null;
  const allExpenses = await fetchAllExpenses(slug, endpoint, statusFilter);

  // Separate tagged and untagged
  // Only use tagged expenses from the last year to inform suggestions
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const tagged = allExpenses.filter((e) => {
    if (!e.tags || e.tags.length === 0) return false;
    const expenseDate = new Date(e.createdAt);
    return expenseDate >= oneYearAgo;
  });
  let untagged = allExpenses.filter((e) => !e.tags || e.tags.length === 0);

  // Apply date filters
  const afterDate = after ? new Date(after) : null;
  const beforeDate = before ? new Date(before) : null;

  if (afterDate || beforeDate) {
    const beforeFilter = untagged.length;
    untagged = untagged.filter((e) => {
      const expenseDate = new Date(e.createdAt);
      if (afterDate && expenseDate < afterDate) return false;
      if (beforeDate && expenseDate > beforeDate) return false;
      return true;
    });
    console.log(
      `\nDate filter: ${afterDate ? `after ${after}` : ''}${afterDate && beforeDate ? ' and ' : ''}${beforeDate ? `before ${before}` : ''}`,
    );
    console.log(`Filtered: ${beforeFilter} → ${untagged.length} untagged expenses`);
  }

  console.log(`\nTagged expenses: ${tagged.length}`);
  console.log(`Untagged expenses: ${untagged.length}`);

  if (untagged.length === 0) {
    console.log('\nNo untagged expenses found. Nothing to do!');
    return;
  }

  if (tagged.length === 0) {
    console.log('\nNo tagged expenses to learn from. All expenses will be skipped.');
    return;
  }

  // Collect all known tags for suggestions
  const allTags = new Set();
  for (const exp of tagged) {
    for (const tag of exp.tags || []) {
      allTags.add(tag);
    }
  }
  const knownTags = [...allTags].sort();

  // Process untagged expenses
  const toProcess = maxToProcess ? untagged.slice(0, maxToProcess) : untagged;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing ${toProcess.length} untagged expenses (newest first)...`);
  console.log(`${'='.repeat(60)}\n`);

  let processed = 0;
  let skipped = 0;
  let updated = 0;
  let autoApprovedCount = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const expense = toProcess[i];

    console.log(`\n--- Expense ${i + 1}/${toProcess.length} ---`);
    console.log(formatExpense(expense, slug));

    let proposedTagsResult = null;
    let similarExpenses = [];

    // Find similar expenses and propose tags
    if (tagged.length > 0) {
      similarExpenses = findSimilarExpenses(expense, tagged, 5);
      const proposal = proposeTags(expense, similarExpenses);

      if (proposal.hasStrongMatch && proposal.tags.length > 0 && proposal.confidence >= minScore) {
        proposedTagsResult = proposal;

        const reset = '\x1b[0m';
        const bold = '\x1b[1m';

        const tagsDisplay = proposal.tags
          .map((t) => `${bold}\x1b[38;5;45m${t.tag}${reset} (${(t.confidence * 100).toFixed(0)}%)`)
          .join(', ');

        console.log(`\nProposed tags: ${tagsDisplay}\n`);

        if (showSimilar) {
          console.log('Similar expenses:');
          similarExpenses.forEach((item, idx) => console.log(formatSimilarExpense(item, idx)));
        }
      } else {
        // No strong payee/description match - auto-skip
        console.log(`\n  Skipped (no similar payee or description match)`);
        skipped++;
        processed++;
        continue;
      }
    } else {
      // No tagged expenses to learn from - skip
      console.log(`\n  Skipped (no tagged expenses to learn from)`);
      skipped++;
      processed++;
      continue;
    }

    // Auto-approve high confidence matches
    if (autoApprove && proposedTagsResult && proposedTagsResult.confidence >= autoApprove) {
      const tagsToApply = proposedTagsResult.tags.map((t) => t.tag);
      console.log(
        `  [AUTO-APPROVE] Confidence ${(proposedTagsResult.confidence * 100).toFixed(0)}% >= ${(autoApprove * 100).toFixed(0)}% threshold`,
      );

      try {
        const result = await updateExpenseTags(expense.id, tagsToApply, endpoint, !isRun);
        if (result.success) {
          console.log(`  ✓ Tags: ${tagsToApply.join(', ')}`);
          updated++;
          autoApprovedCount++;
          expense.tags = tagsToApply;
          tagged.push(expense);
        }
      } catch (error) {
        console.error(`  ✗ Error updating tags: ${error.message}`);
      }

      processed++;
      continue;
    }

    // Ask user for confirmation
    const choices = [];

    if (proposedTagsResult && proposedTagsResult.tags.length > 0) {
      const suggestedTags = proposedTagsResult.tags.map((t) => t.tag);
      choices.push({
        name: `Accept: ${suggestedTags.join(', ')}`,
        value: { type: 'accept', tags: suggestedTags },
      });
    }

    choices.push({ name: 'Select from known tags...', value: { type: 'select' } });
    choices.push({ name: 'Enter tags manually...', value: { type: 'manual' } });
    choices.push({ name: 'Skip this expense', value: { type: 'skip' } });
    choices.push({ name: 'Quit', value: { type: 'quit' } });

    const action = await select({
      message: 'What would you like to do?',
      choices,
    });

    if (action.type === 'quit') {
      console.log('\nQuitting...');
      break;
    }

    if (action.type === 'skip') {
      console.log('  Skipped.');
      skipped++;
      processed++;
      continue;
    }

    let selectedTags = null;

    if (action.type === 'accept') {
      selectedTags = action.tags;
    } else if (action.type === 'select' && knownTags.length > 0) {
      // Multi-select from known tags
      const tagChoices = knownTags.map((t) => ({ name: t, value: t }));
      tagChoices.push({ name: '-- Done selecting --', value: '__done__' });
      tagChoices.push({ name: '-- Cancel --', value: '__cancel__' });

      const selected = [];
      let selecting = true;

      while (selecting) {
        const remaining = tagChoices.filter((c) => !selected.includes(c.value));
        const choice = await select({
          message: `Select tags (${selected.length} selected): ${selected.join(', ') || 'none'}`,
          choices: remaining,
        });

        if (choice === '__done__') {
          selecting = false;
        } else if (choice === '__cancel__') {
          selected.length = 0;
          selecting = false;
        } else {
          selected.push(choice);
        }
      }

      if (selected.length > 0) {
        selectedTags = selected;
      }
    } else if (action.type === 'manual' || (action.type === 'select' && knownTags.length === 0)) {
      const manualTags = await input({
        message: 'Enter tags (comma-separated):',
      });
      selectedTags = manualTags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }

    if (selectedTags && selectedTags.length > 0) {
      try {
        const result = await updateExpenseTags(expense.id, selectedTags, endpoint, !isRun);
        if (result.success) {
          console.log(`  ✓ Tags: ${selectedTags.join(', ')}`);
          updated++;
          expense.tags = selectedTags;
          tagged.push(expense);
        }
      } catch (error) {
        console.error(`  ✗ Error updating tags: ${error.message}`);
      }
    } else {
      console.log('  Skipped (no tags selected).');
      skipped++;
    }

    processed++;
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('Summary:');
  console.log(`  Processed: ${processed}`);
  console.log(`  Updated: ${updated}${autoApprovedCount > 0 ? ` (${autoApprovedCount} auto-approved)` : ''}`);
  console.log(`  Skipped: ${skipped}`);
  if (!isRun) {
    console.log('\n  [DRY RUN] No changes were made. Use --run to apply changes.');
  }
  console.log(`${'='.repeat(60)}`);
}

// ============================================================================
// CLI Setup
// ============================================================================

const program = new Command();

program
  .name('tag-expenses')
  .description('Interactively tag expenses for an Open Collective account')
  .argument('<slug>', 'The collective slug to process expenses for')
  .option('--run', 'Apply changes (default is dry-run mode)')
  .option('--limit <number>', 'Maximum number of expenses to process', parseInt)
  .option('--min-score <number>', 'Minimum confidence score to suggest tags (0-1)', parseFloat, 0.5)
  .option('--auto-approve <number>', 'Auto-approve matches with confidence >= this threshold (0-1)', parseFloat)
  .option('--status <statuses>', 'Comma-separated expense statuses to filter', 'PAID,APPROVED')
  .option('--after <date>', 'Only process expenses after this date (YYYY-MM-DD)')
  .option('--before <date>', 'Only process expenses before this date (YYYY-MM-DD)')
  .option('--show-similar', 'Show similar expenses used for tag suggestion')
  .action(async (slug, options) => {
    const isProduction = process.env.API_URL && process.env.API_URL.includes('api.opencollective.com');

    console.log(`\nExpense Tagging Tool`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Collective: ${slug}`);
    console.log(`Mode: ${options.run ? 'LIVE' : 'DRY RUN'}`);
    console.log(`Environment: ${isProduction ? '🔴 PRODUCTION' : '🟢 Staging/Dev'}`);
    console.log(`API: ${process.env.API_URL}`);
    if (options.limit) console.log(`Limit: ${options.limit} expenses`);
    if (options.status) console.log(`Status filter: ${options.status}`);
    console.log(`Min confidence: ${(options.minScore * 100).toFixed(0)}%`);
    if (options.autoApprove) console.log(`Auto-approve threshold: ${(options.autoApprove * 100).toFixed(0)}%`);
    console.log(`${'='.repeat(60)}\n`);

    await processExpenses({
      slug,
      run: options.run,
      limit: options.limit,
      minScore: options.minScore,
      autoApprove: options.autoApprove,
      status: options.status,
      after: options.after,
      before: options.before,
      showSimilar: options.showSimilar,
    });
  });

// Entry point
if (!module.parent) {
  program.parseAsync(process.argv).catch((e) => {
    if (e.name !== 'CommanderError') {
      console.error(e);
    }
    process.exit(1);
  });
}

module.exports = {
  processExpenses,
  calculateSimilarity,
  findSimilarExpenses,
  proposeTags,
  hasStrongPayeeOrDescriptionMatch,
};
