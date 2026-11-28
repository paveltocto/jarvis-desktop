/** Mail search results from one or more accounts, as text for the model. */
import type { GoogleAccount, ToolContext } from "../tools/types";
import { accountLabel, clientFor, describeFailures, fromEachAccount, successes } from "./accounts";
import { type MailSummary, searchMail } from "./gmail";

export function describeMail(account: GoogleAccount, mail: MailSummary): string {
  return `- From ${mail.from}: ${mail.subject} [account ${account.email}, message_id ${mail.id}] — ${mail.snippet}`;
}

/** Up to `count` messages from each account. Throws when none could be read. */
export async function mailReport(
  ctx: Pick<ToolContext, "fetch" | "accounts">,
  accounts: readonly GoogleAccount[],
  query: string,
  count: number,
  empty: string,
): Promise<string> {
  const outcomes = await fromEachAccount(accounts, "mailRead", (account) =>
    searchMail(clientFor(ctx, account), query, count),
  );
  const sections = successes(outcomes).map(({ account, value }) =>
    [
      `${accountLabel(account)}:`,
      ...(value.length ? value.map((mail) => describeMail(account, mail)) : [empty]),
    ].join("\n"),
  );
  return [...sections, ...describeFailures(outcomes)].join("\n");
}
