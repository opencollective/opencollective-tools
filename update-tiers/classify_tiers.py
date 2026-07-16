#!/usr/bin/env python3
"""
Tier Description Classifier
Classifies open source collective donation tiers as commercial (yes/no),
and subcategorizes commercial tiers (tickets, sponsorships, hosting,
consulting, pre-releases, product, discounts, prioritisation).

Usage:
    python classify_tiers.py --input your_file.csv --output classified.csv

Requires:
    pip install anthropic pandas
"""

import argparse
import json
import time
import sys
import os
import pandas as pd
import anthropic

SYSTEM = """You classify donation tier descriptions for open source projects.

For each description, answer YES or NO. If YES, also assign exactly one subcategory.

YES — the tier offers a concrete commercial product, service, or benefit with real-world value. Examples, grouped by subcategory:
- consulting: office hours, scheduled video/phone calls, 1:1 catchups with maintainers, monthly consulting sessions, commissioned or custom development work, training sessions
- prioritisation: guaranteed/committed response — an explicit promise to answer emails, issues, or bug reports within a stated time window; an offer to implement a specific feature or fix a specific issue or bug UNLESS the tier is dedicated to that specific feature, issue, or bug; project acquisition opportunities
- sponsorships: direct advertising — clickable banner ads on a website, in-game, or in an app (not just a static logo in a README or docs)
- hosting: hosted or managed services — fully managed instances, VPS setup, long-term managed hosting
- product: access to paid or premium app features; commercial software keys such as game keys or software licences
- tickets: event tickets or event registration
- discounts: discount codes or reduced pricing on a paid product, service, ticket, or subscription
- pre-releases: exclusive pre-release or early access that is itself part of a paid commercial offering (generic beta/early access on its own is NO — see below)

NO — the tier offers only recognition, low-value perks, or intangible acknowledgements. Examples:
- Name, logo, or avatar in README, docs, website, about screen, backers list, or changelog
- Roadmap/product influence: membership of a steering committee or stakeholder group, voting rights on features, feature priority polls that affect development
- Social media mentions, shoutouts, or thank-you tweets
- Newsletters or update emails (even "private" or "exclusive" ones)
- Discord, Telegram, Slack, or other chat roles, badges, or channel access (including "exclusive" or "private" channels)
- Pre-release builds, beta access, early access, RC builds, or insider builds
- Priority or faster handling of issues, bug fixes, or support requests via chat or GitHub
- Stickers, t-shirts, mugs, or other small/low-value physical merchandise
- Vague or informal priority support not structured as office hours or scheduled calls
- Presence on a merch table, logo on an event page, or group social media post
- Promises of future (unspecified) gifts or benefits
- Hiding UI support links or other minor UI cosmetics
- Community event funding acknowledgements
- Sponsor-only GitHub discussions or forum access

Respond ONLY with a JSON array. Each element: {"index": <original_index>, "commercial": "yes"/"no", "subcategory": "<one of: tickets, sponsorships, hosting, consulting, pre-releases, product, discounts, prioritisation — or empty string if commercial is no>", "note": "<brief reason max 10 words, or empty>"}
No markdown, no explanation outside the JSON."""

ALLOWED_SUBCATEGORIES = {
    "tickets", "sponsorships", "hosting", "consulting",
    "pre-releases", "product", "discounts", "prioritisation",
}

SYSTEM_SUBCATEGORIZE = """You have already confirmed that each of the following texts describes a
donation tier that offers a concrete commercial product, service, or benefit. Your only job is to
assign exactly one subcategory to each, based on these definitions:

- consulting: office hours, scheduled video/phone calls, 1:1 catchups with maintainers, monthly consulting sessions, commissioned or custom development work, training sessions
- prioritisation: guaranteed/committed response — an explicit promise to answer emails, issues, or bug reports within a stated time window; an offer to implement a specific feature or fix a specific issue or bug UNLESS the tier is dedicated to that specific feature, issue, or bug; project acquisition opportunities
- sponsorships: direct advertising — clickable banner ads on a website, in-game, or in an app (not just a static logo in a README or docs)
- hosting: hosted or managed services — fully managed instances, VPS setup, long-term managed hosting
- product: access to paid or premium app features; commercial software keys such as game keys or software licences
- tickets: event tickets or event registration
- discounts: discount codes or reduced pricing on a paid product, service, ticket, or subscription
- pre-releases: exclusive pre-release or early access that is itself part of a paid commercial offering

Respond ONLY with a JSON array. Each element: {"index": <original_index>, "subcategory": "<one of: tickets, sponsorships, hosting, consulting, pre-releases, product, discounts, prioritisation>"}
No markdown, no explanation outside the JSON."""


def _clean(value) -> str:
    """Normalize a possibly-missing/NaN CSV cell to a stripped string, or empty string."""
    return str(value).strip() if pd.notna(value) else ""


def sanitize(text: str, max_len: int = 280) -> str:
    """Remove characters that break JSON and truncate."""
    # Replace newlines and tabs with spaces
    text = text.replace("\n", " ").replace("\r", " ").replace("\t", " ")
    # Remove control characters
    text = "".join(c for c in text if ord(c) >= 32 or c in " ")
    # Collapse multiple spaces
    text = " ".join(text.split())
    return text[:max_len]


def parse_response(text: str) -> list[dict]:
    """Parse the model's JSON response, with fallbacks for common formatting issues."""
    text = text.strip()

    # Strip markdown fences
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:])
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3].strip()
    text = text.strip()

    # Try direct parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Extract just the JSON array using bracket matching
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end != -1 and end > start:
        candidate = text[start:end + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass

    # Last resort: try using json5-style tolerant parsing via ast for simple cases
    # Print the raw text so the user can see what went wrong
    print("\n--- RAW MODEL RESPONSE (first 500 chars) ---")
    print(repr(text[:500]))
    print("--- END RAW RESPONSE ---\n")
    raise ValueError("Could not parse model response as JSON — see raw output above")


def classify_batch(client, batch: list[dict]) -> list[dict]:
    """Send a batch of rows to the API and return classifications."""
    items = [{"index": r["index"], "description": sanitize(r["description"])} for r in batch]
    # ensure_ascii=True avoids encoding issues with emoji and non-latin chars
    payload = json.dumps(items, ensure_ascii=True)

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        system=SYSTEM,
        messages=[{"role": "user", "content": payload}]
    )

    return parse_response(message.content[0].text)


def subcategorize_batch(client, batch: list[dict]) -> list[dict]:
    """Send a batch of already-commercial rows to the API and return subcategory assignments."""
    items = [{"index": r["index"], "description": sanitize(r["text"])} for r in batch]
    payload = json.dumps(items, ensure_ascii=True)

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        system=SYSTEM_SUBCATEGORIZE,
        messages=[{"role": "user", "content": payload}]
    )

    return parse_response(message.content[0].text)


def main():
    parser = argparse.ArgumentParser(description="Classify tier descriptions as commercial or not")
    parser.add_argument("--input", required=True, help="Path to input CSV file")
    parser.add_argument("--output", default="classified.csv", help="Path to output CSV file")
    parser.add_argument("--batch-size", type=int, default=25, help="Rows per API call (default 25)")
    parser.add_argument("--resume", default=None, help="Path to partial results JSON to resume from")
    args = parser.parse_args()

    # Load API key
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Error: ANTHROPIC_API_KEY environment variable not set.")
        print("Set it with: export ANTHROPIC_API_KEY=sk-ant-...")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)

    # Load CSV
    print(f"Loading {args.input}...")
    df = pd.read_csv(args.input)
    print(f"Loaded {len(df)} rows")

    # Load resume state if provided
    classify_results = {}
    subcat_results = {}
    if args.resume and os.path.exists(args.resume):
        with open(args.resume) as f:
            checkpoint_data = json.load(f)
        classify_results = checkpoint_data.get("classify", {})
        subcat_results = checkpoint_data.get("subcategorize", {})
        print(f"Resuming: {len(classify_results)} classified, {len(subcat_results)} subcategorized")

    def save_checkpoint():
        checkpoint = args.output.replace(".csv", "_checkpoint.json")
        with open(checkpoint, "w") as f:
            json.dump({"classify": classify_results, "subcategorize": subcat_results}, f)
        print(f"  Checkpoint saved to {checkpoint}")

    # Triage rows: fresh classification, subcategory backfill, or already done
    to_classify = []
    to_subcategorize = []
    for i, row in df.iterrows():
        desc = _clean(row.get("Description"))
        existing_commercial = _clean(row.get("commercial_product_service"))
        existing_subcategory = _clean(row.get("commercial_subcategory"))
        existing_notes = _clean(row.get("notes"))

        if existing_commercial == "":
            if desc and str(i) not in classify_results:
                to_classify.append({"index": i, "description": desc})
        elif existing_commercial == "yes":
            if existing_subcategory == "" and str(i) not in subcat_results:
                text = existing_notes or desc
                if text:
                    to_subcategorize.append({"index": i, "text": text})
                else:
                    print(f"  Warning: row {i} is YES but has no notes or Description to subcategorize, skipping")
        elif existing_commercial != "no":
            print(f"  Warning: row {i} has unrecognized commercial_product_service value {existing_commercial!r}, skipping")

    print(f"Rows to classify: {len(to_classify)}")
    print(f"Rows to subcategorize: {len(to_subcategorize)}")

    # Pass A: fresh commercial + subcategory classification
    if not to_classify:
        print("Nothing to classify - all rows already done.")
    else:
        total_batches = (len(to_classify) + args.batch_size - 1) // args.batch_size
        classified = 0
        yes_count = sum(1 for v in classify_results.values() if v.get("commercial") == "yes")

        for b in range(total_batches):
            batch = to_classify[b * args.batch_size:(b + 1) * args.batch_size]

            for attempt in range(3):
                try:
                    classified_batch = classify_batch(client, batch)
                    for item in classified_batch:
                        subcategory = item.get("subcategory", "") if item["commercial"] == "yes" else ""
                        if item["commercial"] == "yes" and subcategory not in ALLOWED_SUBCATEGORIES:
                            print(f"  Warning: row {item['index']} has unrecognized subcategory {subcategory!r}")
                        classify_results[str(item["index"])] = {
                            "commercial": item["commercial"],
                            "subcategory": subcategory,
                            "note": item.get("note", "")
                        }
                        if item["commercial"] == "yes":
                            yes_count += 1
                    classified += len(classified_batch)
                    break
                except Exception as e:
                    print(f"  Batch {b+1} attempt {attempt+1} failed: {e}")
                    if attempt < 2:
                        time.sleep(2)
                    else:
                        print(f"  Batch {b+1} skipped after 3 failures")

            pct = round(classified / len(to_classify) * 100)
            print(f"Classify batch {b+1}/{total_batches} done | {classified}/{len(to_classify)} ({pct}%) | YES so far: {yes_count}")

            if (b + 1) % 10 == 0:
                save_checkpoint()

            time.sleep(0.3)  # slight delay to avoid rate limits

    # Pass B: subcategory backfill for rows already known to be commercial
    if not to_subcategorize:
        print("Nothing to subcategorize - all commercial rows already have one.")
    else:
        total_batches = (len(to_subcategorize) + args.batch_size - 1) // args.batch_size
        subcategorized = 0

        for b in range(total_batches):
            batch = to_subcategorize[b * args.batch_size:(b + 1) * args.batch_size]

            for attempt in range(3):
                try:
                    subcat_batch = subcategorize_batch(client, batch)
                    for item in subcat_batch:
                        subcategory = item.get("subcategory", "")
                        if subcategory not in ALLOWED_SUBCATEGORIES:
                            print(f"  Warning: row {item['index']} has unrecognized subcategory {subcategory!r}")
                        subcat_results[str(item["index"])] = {"subcategory": subcategory}
                    subcategorized += len(subcat_batch)
                    break
                except Exception as e:
                    print(f"  Batch {b+1} attempt {attempt+1} failed: {e}")
                    if attempt < 2:
                        time.sleep(2)
                    else:
                        print(f"  Batch {b+1} skipped after 3 failures")

            pct = round(subcategorized / len(to_subcategorize) * 100)
            print(f"Subcategorize batch {b+1}/{total_batches} done | {subcategorized}/{len(to_subcategorize)} ({pct}%)")

            if (b + 1) % 10 == 0:
                save_checkpoint()

            time.sleep(0.3)  # slight delay to avoid rate limits

    # Build output dataframe - only touch cells actually processed, preserve everything else
    print("\nBuilding output CSV...")
    for col in ("commercial_product_service", "commercial_subcategory", "notes"):
        if col not in df.columns:
            df[col] = ""
        else:
            df[col] = df[col].fillna("")

    for idx_str, result in classify_results.items():
        idx = int(idx_str)
        df.at[idx, "commercial_product_service"] = result.get("commercial", "")
        df.at[idx, "commercial_subcategory"] = result.get("subcategory", "")
        df.at[idx, "notes"] = result.get("note", "")

    for idx_str, result in subcat_results.items():
        idx = int(idx_str)
        df.at[idx, "commercial_subcategory"] = result.get("subcategory", "")

    df.to_csv(args.output, index=False)

    total_yes = (df["commercial_product_service"] == "yes").sum()
    total_no = (df["commercial_product_service"] == "no").sum()
    total_blank = (df["commercial_product_service"] == "").sum()
    missing_subcategory = ((df["commercial_product_service"] == "yes") & (df["commercial_subcategory"] == "")).sum()

    print(f"\nDone! Output written to {args.output}")
    print(f"  This run: {len(classify_results)} classified, {len(subcat_results)} subcategorized")
    print(f"  YES (commercial):             {total_yes}")
    print(f"  NO:                           {total_no}")
    print(f"  Blank (no desc/unclassified): {total_blank}")
    print(f"  YES missing subcategory:      {missing_subcategory}")
    print("  Subcategory breakdown (YES only, full file):")
    for subcat in sorted(ALLOWED_SUBCATEGORIES):
        count = (df["commercial_subcategory"] == subcat).sum()
        print(f"    {subcat}: {count}")


if __name__ == "__main__":
    main()
