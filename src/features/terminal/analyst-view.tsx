"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { Bot, CircleAlert, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/trading/panel";
import { AnalystClient, type AnalystAnswerView, type AnalystSessionView, type ToolEvidenceView } from "@/adapters/http/analyst-client";
import { ApiError } from "@/adapters/http/nova-api-client";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useTerminal } from "./terminal-context";

const SUGGESTED = [
  "Why did my equity change today?",
  "How much did I pay in fees and funding?",
  "Which position contributes most to my portfolio exposure?",
  "What would happen to my unrealized P&L if this market moved 3%?",
  "Summarize my recent executions.",
];

const KIND_STYLE = {
  fact: "bg-primary/15 text-primary",
  estimate: "bg-warning/15 text-warning",
  hypothetical: "bg-private/15 text-private",
} as const;
const KIND_LABEL = { fact: "Fact", estimate: "Estimate", hypothetical: "Hypothetical" } as const;

type Exchange = { id: number; question: string; answer: AnalystAnswerView | null; error: string | null };

const utc = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * AI Trading Analyst. Answers come from the server: a model (or the offline
 * analyst) narrates figures produced by read-only, authorized tools. The
 * verified figures are shown under every answer and are the source of truth.
 */
export function AnalystView() {
  const { selected } = useTerminal();
  const [client] = useState(() => new AnalystClient());
  const [status, setStatus] = useState<"loading" | "signed-out" | "signed-in" | "unavailable">("loading");
  const [session, setSession] = useState<AnalystSessionView | null>(null);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Exchange[]>([]);
  const ids = useId();

  useEffect(() => {
    let cancelled = false;
    client
      .session()
      .then(async (s) => {
        if (cancelled) return;
        if (s) {
          setSession(s);
          setAccountId(s.accounts[0]?.id ?? null);
          setStatus("signed-in");
        } else {
          setUsers(await client.users());
          if (!cancelled) setStatus("signed-out");
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setStatus(e instanceof ApiError && e.status === 404 ? "unavailable" : "signed-out");
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const signIn = async (userId: string) => {
    const s = await client.signIn(userId);
    setSession(s);
    setAccountId(s.accounts[0]?.id ?? null);
    setHistory([]);
    setStatus("signed-in");
  };

  const signOut = async () => {
    await client.signOut();
    setSession(null);
    setHistory([]);
    setUsers(await client.users());
    setStatus("signed-out");
  };

  const ask = async (q: string) => {
    const text = q.trim();
    if (!text || busy) return;
    const id = Date.now();
    setHistory((h) => [{ id, question: text, answer: null, error: null }, ...h]);
    setQuestion("");
    setBusy(true);
    try {
      const answer = await client.ask(text, accountId, selected?.market.id ?? null);
      setHistory((h) => h.map((x) => (x.id === id ? { ...x, answer } : x)));
    } catch (e) {
      setHistory((h) => h.map((x) => (x.id === id ? { ...x, error: e instanceof Error ? e.message : "Request failed" } : x)));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(question);
  };

  return (
    <main id="main" className="flex-1 overflow-y-auto" data-testid="analyst-page">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 md:p-6">
        <header className="flex flex-col gap-2">
          <p className="flex items-center gap-2 text-xs font-medium text-primary uppercase">
            <Bot className="size-3.5" aria-hidden /> AI Trading Analyst
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Ask about your account</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Answers are built from read-only queries of your own account data and tested calculations. The analyst cannot place, cancel or modify orders,
            and it does not predict prices.
          </p>
          <p className="w-fit rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1 text-xs text-warning" data-testid="analyst-mock-banner">
            Demo: mock sign-in and fictitious mock accounts (MOCKUSD). Not connected to any real account, venue or funds.
          </p>
        </header>

        {status === "loading" && <p className="text-sm text-muted-foreground">Loading…</p>}

        {status === "unavailable" && (
          <p className="text-sm text-muted-foreground" data-testid="analyst-unavailable">
            The analyst is only available in the demo environment with mock accounts in this milestone.
          </p>
        )}

        {status === "signed-out" && (
          <Panel title="Mock sign-in">
            <div className="space-y-2 p-3" data-testid="analyst-sign-in">
              <p className="text-xs text-muted-foreground">Choose a demo identity. Each one can only read its own mock accounts.</p>
              <div className="flex flex-wrap gap-2">
                {users.map((u) => (
                  <Button key={u.id} variant="outline" onClick={() => void signIn(u.id)} data-testid={`analyst-user-${u.id}`}>
                    {u.name}
                  </Button>
                ))}
              </div>
            </div>
          </Panel>
        )}

        {status === "signed-in" && session && (
          <>
            <Panel
              title={`Signed in as ${session.user.name}`}
              actions={
                <Button size="sm" variant="ghost" onClick={() => void signOut()} data-testid="analyst-sign-out">
                  <LogOut aria-hidden /> Sign out
                </Button>
              }
            >
              <form onSubmit={submit} className="space-y-3 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor={`${ids}-account`} className="text-sm">
                    Account
                  </label>
                  <select
                    id={`${ids}-account`}
                    className="h-9 rounded-md border bg-transparent px-2 text-sm"
                    value={accountId ?? ""}
                    onChange={(e) => setAccountId(e.target.value || null)}
                    data-testid="analyst-account"
                  >
                    {session.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-muted-foreground">“This market” means {selected?.market.id ?? "the market selected on the Trade page"}.</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {SUGGESTED.map((q) => (
                    <Button key={q} type="button" size="sm" variant="outline" className="h-auto py-1 text-xs whitespace-normal" onClick={() => void ask(q)} disabled={busy} data-testid="analyst-suggestion">
                      {q}
                    </Button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <label htmlFor={`${ids}-q`} className="sr-only">
                    Question
                  </label>
                  <input
                    id={`${ids}-q`}
                    className="h-9 min-w-0 flex-1 rounded-md border bg-transparent px-3 text-sm"
                    maxLength={500}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="Ask about equity, fees, funding, exposure, scenarios or executions"
                    data-testid="analyst-question"
                  />
                  <Button type="submit" disabled={busy || question.trim() === ""} data-testid="analyst-ask">
                    Ask
                  </Button>
                </div>
              </form>
            </Panel>

            <ol className="flex flex-col gap-3" aria-live="polite" data-testid="analyst-history">
              {history.map((x) => (
                <li key={x.id} className="rounded-md border p-3" data-testid="analyst-exchange">
                  <p className="text-sm font-medium">{x.question}</p>
                  {!x.answer && !x.error && <p className="mt-2 text-xs text-muted-foreground">Working…</p>}
                  {x.error && (
                    <p className="mt-2 text-sm text-sell" role="alert">
                      {x.error}
                    </p>
                  )}
                  {x.answer && <AnswerView answer={x.answer} />}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </main>
  );
}

function AnswerView({ answer }: { answer: AnalystAnswerView }) {
  return (
    <div className="mt-2 space-y-3" data-testid="analyst-answer" data-refused={answer.refused} data-engine={answer.engine}>
      <p className="text-2xs text-muted-foreground">
        {answer.engineLabel} · answered {utc(answer.asOf)}
      </p>
      <div className="text-sm whitespace-pre-wrap" data-testid="analyst-answer-text">
        {answer.answer}
      </div>
      {answer.warnings.length > 0 && (
        <ul className="space-y-1" data-testid="analyst-warnings">
          {answer.warnings.map((w) => (
            <li key={w} className="flex gap-1.5 text-xs text-warning">
              <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden /> {w}
            </li>
          ))}
        </ul>
      )}
      {answer.evidence.map((e, i) => (
        <EvidenceCard key={`${e.tool}-${i}`} evidence={e} />
      ))}
      <p className="text-2xs text-muted-foreground" data-testid="analyst-disclaimer">
        {answer.disclaimer}
      </p>
    </div>
  );
}

function EvidenceCard({ evidence }: { evidence: ToolEvidenceView }) {
  return (
    <section className="rounded-md border bg-background/40 p-2.5" data-testid="analyst-evidence" data-tool={evidence.tool}>
      <h3 className="flex flex-wrap items-baseline justify-between gap-2 text-xs font-semibold">
        <span>Verified data: {evidence.title}</span>
        <span className="font-normal text-muted-foreground">
          {evidence.dataSource} · calculated {utc(evidence.asOf)}
        </span>
      </h3>
      {evidence.unavailable.map((u) => (
        <p key={u.label} className="mt-1 text-xs text-sell" data-testid="analyst-unavailable-item">
          Unavailable — {u.label}: {u.reason}
        </p>
      ))}
      {evidence.items.length > 0 && (
        <table className="mt-1.5 w-full text-xs">
          <tbody>
            {evidence.items.map((item, i) => (
              <tr key={`${item.label}-${i}`} className="border-b last:border-0 align-top" data-kind={item.kind}>
                <td className="py-1 pr-2">
                  {item.label}
                  {item.note && <span className="block text-2xs text-muted-foreground">{item.note}</span>}
                </td>
                <td className="py-1 text-right tabular whitespace-nowrap">{item.display}</td>
                <td className="py-1 pl-2 text-right">
                  <span className={cn("rounded px-1.5 py-0.5 text-2xs font-semibold", KIND_STYLE[item.kind])}>{KIND_LABEL[item.kind]}</span>
                </td>
                <td className="hidden py-1 pl-2 text-right text-2xs text-muted-foreground sm:table-cell">{item.asOf === null ? "" : formatTime(item.asOf)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {evidence.assumptions.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-2xs text-muted-foreground">
          {evidence.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
