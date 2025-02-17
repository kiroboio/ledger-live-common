// @flow

import invariant from "invariant";
import type { Transaction, AccountLike } from "../../types";

const options = [
  {
    name: "fee",
    type: String,
    desc: "how much fee"
  },
  {
    name: "tag",
    type: Number,
    desc: "ripple tag"
  }
];

function inferTransactions(
  transactions: Array<{ account: AccountLike, transaction: Transaction }>,
  opts: Object,
  { inferAmount }: *
): Transaction[] {
  return transactions.flatMap(({ transaction, account }) => {
    invariant(transaction.family === "ripple", "ripple family");
    return {
      ...transaction,
      fee: inferAmount(account, opts.fee || "0.001xrp"),
      tag: opts.tag
    };
  });
}

export default {
  options,
  inferTransactions
};
