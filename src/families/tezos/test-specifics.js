// @flow

import { fromAccountRaw } from "../../account";
import dataset from "./test-dataset";
import { loadAccountDelegation, listBakers } from "./bakers";
import whitelist from "./bakers.whitelist-default";

export default () => {
  describe("tezos bakers", () => {
    test("getting the bakers", async () => {
      const list = await listBakers(whitelist);
      expect(list.map(o => o.address)).toEqual(whitelist);
    });

    // TODO we'll need two accounts to test diff cases
    test("load account baker info", async () => {
      const account = fromAccountRaw(dataset.currencies.tezos.accounts[0].raw);
      const delegation = await loadAccountDelegation(account);
      expect(delegation).toBe(null);
    });
  });
};
