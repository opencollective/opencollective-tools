# Vite Ecosystem Fund distribution

Distributes money from the [Vite Ecosystem Fund](https://opencollective.com/cloudflare/projects/vite-ecosystem-fund) to the recipients listed in a CSV. Recipients that can receive a contribution from the Fund get one (one-time or monthly, as the CSV says). Everyone else gets an expense invite through Open Collective.

The script is meant to be **run repeatedly**, once a month, with the CSV updated between runs (see [Monthly re-runs](#monthly-re-runs)).

The CSV, `results.json` (the local ledger of completed rows) and any `.with-links.csv` copy contain recipient details. They are gitignored by `cloudflare_distribution/.gitignore`. Never commit them.

## Setup

Needs `PERSONAL_TOKEN` and `API_URL` in a `.env` file for an admin of the Fund. The token needs the scopes for creating contributions and expenses.

`.env` is read from the directory you run the command in, so run from the `opencollective-tools` root:

```
cd opencollective-tools
```

`API_URL` defaults to staging, but the Fund only exists on production, so set `API_URL=https://api.opencollective.com`. The first line of output shows the API in use. Variables already exported in your shell take precedence over `.env`.

## CSV format

Columns: `name, URLs, Amounts, monthly vs one-time, Personal or Project?, Donation URL, contact address, Status, Notes`.

- `Donation URL`: the recipient's opencollective.com page, if they have one (falls back to an opencollective.com link in `URLs`). Leave empty if they have no account.
- `Amounts`: e.g. `$1,500`, in USD.
- `monthly vs one-time`: `Monthly` or `One-off`.
- `contact address`: who the invite is sent to when the recipient has no account.
- `Status`: `Sent` or a link, both mean the row has been handled (see below).

## Usage

```
node cloudflare_distribution/import.js "<csv>"                 # dry run, changes nothing
node cloudflare_distribution/import.js "<csv>" --run           # for real, asks for confirmation
node cloudflare_distribution/import.js "<csv>" --update-csv    # also write a copy of the CSV with links
node cloudflare_distribution/import.js "<csv>" --run --update-csv --delay 30
```

Always do a dry run first and read the summary. Console output uses row ids (`R01`...) instead of names or emails.

| Option                 | Meaning                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `--run`                | Create contributions and invites. Without it nothing is changed.                    |
| `--yes`                | Skip the confirmation prompt (with `--run`).                                        |
| `--update-csv`         | Write `<name>.with-links.csv` with a link in `Status` for each handled row.         |
| `--delay <seconds>`    | Wait after each invite expense (default 20). Invites are rate limited by the API.   |
| `--fund <slug>`        | Fund making the payments (default `vite-ecosystem-fund`).                           |
| `--ledger <path>`      | Where completed rows are recorded (default `cloudflare_distribution/results.json`). |
| `--description <text>` | Description used for invite expenses.                                               |

If the API rate limit is hit anyway, the script stops. Rows completed so far are saved, so just rerun later (or with a larger `--delay`).

## How rows are handled

Every row is put in one bucket and the summary prints the bucket, amount, frequency, account and the reason.

| Bucket                     | Meaning                                                                                                                 | What `--run` does                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ready`                    | Account exists, is active and is on the same host as the Fund                                                           | Creates a contribution from the Fund balance (one-time or monthly) |
| `existing-account-expense` | Account exists but is on another host, has no host, or is not active yet                                                | Sends an expense invite to the existing account                    |
| `needs-invite`             | No Open Collective account                                                                                              | Sends an expense invite to the contact address                     |
| `already-contributed`      | The Fund already paid the recipient this month, has an active monthly contribution to it, or has an open expense for it | Nothing                                                            |
| `skipped-sent`             | `Status` is `Sent`, or already holds a link                                                                             | Nothing                                                            |
| `already-done`             | Handled in an earlier run (found in `results.json`)                                                                     | Nothing                                                            |
| `ambiguous`, `invalid`     | Account lookup failed, account archived or frozen, no contact address, or unparsable amount/frequency                   | Nothing, fix the row and rerun                                     |

Notes:

- **Balance contributions only work within one host**, which is why recipients on other hosts get an expense instead.
- **An expense invite is a payout, not a contribution.** It appears in the Fund's expenses, not as a donation on the recipient's page.
- **Invite flow.** The recipient gets an email, creates an account (or signs in), sets a payout method and submits. The amount and description are locked. Monthly recipients get a note explaining that the amount is meant to be sent monthly and asking them to create a Collective and share its URL (`invite-note-monthly.md`, other recipients get `invite-note.md`). Edit these files to change the wording, `{{amount}}` is filled in per row.
- **Same account in several rows** (for example a monthly and a one-time payment): each row is handled on its own, and the script warns that the "already paid" checks cannot tell them apart, so check the Fund's activity for that account by hand.
- **Duplicate protection.** Besides `results.json`, the script asks the Open Collective API what the Fund has already paid this month, which monthly contributions are active and which expenses are open, and skips those recipients. Check that the rows you expect to be skipped show up in `already-contributed` or `already-done`.

## Monthly re-runs

Run the script again every month with the same command. A typical cycle:

1. **Update the CSV.** For recipients who were invited and have since created a Collective on Open Collective, put its URL in `Donation URL`. Add new recipients as new rows.
2. **Dry run.** Handled rows show as `already-done`, `already-contributed` or `skipped-sent`. Only new rows and follow-ups should be left to process.
3. **Run with `--run --update-csv`**, then use the `.with-links.csv` file as the CSV from now on.

What happens to rows from earlier runs:

- **One-time rows** that were paid or invited stay finished. They are never paid again, even in later months (this relies on `results.json`, or a link or `Sent` in `Status`).
- **Monthly rows that went out as an invite** are followed up once the recipient has an account that can receive contributions from the Fund (same host as the Fund, active) and the CSV has its URL. The run then creates the **monthly contribution** and the row moves to `ready` with the reason "invite was sent earlier...". The follow-up is **never done in the same month as the invite**, since the invite already pays that month. Until then the row stays `already-done`.
- **Monthly rows that were set up as a contribution** keep running by themselves. Open Collective charges them every month, nothing to rerun. They show up as `already-done` or `already-contributed`.
- **Monthly recipients still on a different host** keep appearing as `already-done` after their first invite. Their next payments have to be sent some other way (a new invite, or move them to a host that can receive balance contributions).

Before a follow-up, check on the Fund's expenses page that the earlier invite expense was actually paid or cancelled. If it is still pending when the monthly contribution starts, the recipient could be paid twice for the first month.

To redo a row that was handled by mistake, delete its entry from `results.json` (and clear its `Status` in the CSV), then rerun.

## Corrections and resends

Before skipping a row that is in `results.json`, the script checks what happened to the expense or contribution it created. If that payment **failed**, it is sent again, **but only when the row now has a different payee**. Failed means:

- an expense that was rejected, cancelled, declined (`INVITE_DECLINED`), in error, marked as spam or **deleted**
- a contribution that was rejected, cancelled, expired, in error or **deleted**
- an expense or contribution that was **refunded**

The payee is the Open Collective account in `Donation URL` when there is one, and the `contact address` (case-insensitive) otherwise. So to fix a mistake, correct the row in the CSV (a new contact address, or the URL of the right Collective) and rerun. In the dry run these rows show as `[resend]` reasons in their bucket (`ready`, `existing-account-expense` or `needs-invite`), for example "Resending, previous expense #123 (REJECTED) went to a different payee".

| Previous payment                         | Payee in the CSV | Result                                               |
| ---------------------------------------- | ---------------- | ---------------------------------------------------- |
| Failed                                   | Different        | Sent again                                           |
| Failed                                   | Same             | Not sent again (`already-done`)                      |
| Failed, `INVITE_DECLINED`, payee unknown | Any              | Not sent again, the recipient said no                |
| Failed, other status, payee unknown      | Any              | Sent again, the reason says "previous payee unknown" |
| Still alive (pending, approved, paid...) | Any              | Left alone                                           |

Things to know:

- **A resend ignores a link or `Sent` in `Status`**, since that link points at the failed payment.
- **The payee is recorded in `results.json` from now on.** Entries written by earlier versions of the script do not have it. For those, the script tries to work it out (the invited email of a draft, the account of an expense on an existing account), but a rejected or deleted invite no longer exposes the email. In that case the payee counts as unknown and the row is sent again even if the address did not change, so **read the dry run before `--run`**.
- **History is kept.** When a row is sent again, the old entry is stored under `history` in its new ledger entry.
- **A failed payment to the same payee is never retried automatically.** If you want it sent again anyway, delete its entry from `results.json` and clear its `Status`.
- **Deleted and refunded payments are only found through the ledger.** A payment that was never recorded there is not tracked.
- Each ledger row costs one extra API call per run, plus a full read of the Fund's transactions to find refunds.

## Links in the CSV

`--update-csv` writes a copy of the CSV (`<name>.with-links.csv`, the original is untouched) where the `Status` column holds a link to the order or expense for each row that has one. Links come from `results.json` and from activity the Fund already has:

- Expense invites: `https://opencollective.com/cloudflare/projects/vite-ecosystem-fund/expenses/<id>`
- Contributions: `https://opencollective.com/<recipient>/contributions/<id>` (projects and events include their parent in the path)

The domain follows `API_URL`. Rows without an order or expense are left as they were. Rows whose `Status` is `Sent` or a link are skipped on later runs, so use the `.with-links.csv` file as the input going forward. For monthly rows with an invite link, the follow-up described above still applies once the Donation URL is updated.
