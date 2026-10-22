# Vite Ecosystem Fund distribution

Creates contributions (and expense invites) from the Vite Ecosystem Fund to the recipients in a CSV.

The CSV and `results.json` (the local ledger of completed rows) contain recipient details and are gitignored. Never commit them.

## Usage

Needs `PERSONAL_TOKEN` and `API_URL` in `.env` (see the repo README) for an admin of the Fund. Use staging first (`API_URL=https://api-staging.opencollective.com`).

```
node cloudflare_distribution/import.js "<csv>"          # dry run
node cloudflare_distribution/import.js "<csv>" --run    # for real (asks for confirmation)
```

Options: `--fund <slug>` (default `vite-ecosystem-fund`), `--ledger <path>`, `--description <text>`, `--delay <seconds>` (wait between invites, default 20), `--update-csv`, `--yes`.

Console output uses row ids (`R01`...) instead of names or emails.

## How rows are handled

| Bucket                                 | Meaning                                                                                     | Action                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `ready`                                | Account exists, active, same host as the Fund                                               | `createOrder` from the Fund balance (one-time or monthly) |
| `existing-account-expense`             | Account exists but is on another host, has no host, or is not active yet                    | Expense invite to the existing account                    |
| `needs-invite`                         | No Open Collective account                                                                  | Expense invite to the contact address                     |
| `already-contributed`                  | Fund already paid the recipient this month, has an active monthly order, or an open expense | Skipped                                                   |
| `skipped-sent`                         | `Status` is Sent                                                                            | Skipped                                                   |
| `already-done`, `invalid`, `ambiguous` | Done in an earlier run, unparsable row, or needs manual review                              | Skipped, reason printed                                   |

Balance contributions only work between accounts on the same host, which is why other hosts get an expense instead. An expense invite is a payout, so it shows up in the Fund's expenses, not as a contribution on the recipient's page. For monthly rows that are invited, only the first payment is created. Once the recipient has a Collective, update the CSV `Donation URL` and rerun to set up the monthly contribution (check the pending invite expense first so the first month is not paid twice).

## Links in the CSV

Add `--update-csv` to write a copy of the CSV (`<name>.with-links.csv`, the original is untouched) where the `Status` column holds a link to the order or expense for each row that has one, taken from `results.json` and from activity the Fund already has. Rows whose `Status` is `Sent` or a link are skipped on later runs, so use the `.with-links.csv` file as the input going forward if you want that protection to cover them.
