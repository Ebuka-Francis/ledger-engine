export type Side = "debit" | "credit";

export type Account = {
  code: string;
  name: string;
  type: string;
  currency: string;
  allowNegative: boolean;
};

export type TrialRow = {
  code: string;
  name: string;
  type: string;
  currency: string;
  debits: string;
  credits: string;
  balance: string;
};

export type TrialTotals = { currency: string; debits: string; credits: string; balanced: boolean };

export type TrialBalance = {
  asOf: string | null;
  accounts: TrialRow[];
  totals: TrialTotals[];
  balanced: boolean;
};

export type StatementLine = {
  transactionId: string;
  postedAt: string;
  description: string | null;
  direction: Side;
  amount: string;
  balance: string;
};

export type Statement = { account: string; currency: string; lines: StatementLine[]; hasMore: boolean };

export type TxEntry = { account: string; direction: Side; amount: string; currency: string };

export type Tx = {
  id: string;
  description: string | null;
  postedAt: string;
  reversesTransactionId: string | null;
  entries: TxEntry[];
};

export type Check = { name: string; ok: boolean; count: number; samples: Record<string, unknown>[] };
export type Recon = { ok: boolean; checks: Check[] };

export type PostResult = { transactionId: string; replayed: boolean };
