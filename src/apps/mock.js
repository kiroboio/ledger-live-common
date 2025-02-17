// @flow
import { of, throwError } from "rxjs";
import {
  ManagerAppDepInstallRequired,
  ManagerAppDepUninstallRequired
} from "@ledgerhq/errors";
import { getDirectDep, getDependencies } from "./polyfill";
import { findCryptoCurrency } from "../currencies";
import type { ListAppsResult, AppOp, Exec, InstalledItem } from "./types";
import type {
  ApplicationVersion,
  DeviceInfo,
  FinalFirmware
} from "../types/manager";

export const deviceInfo155 = {
  version: "1.5.5",
  isBootloader: false,
  isOSU: false,
  managerAllowed: false,
  mcuVersion: "1.7",
  pinValidated: false,
  providerId: 1,
  majMin: "1.5",
  targetId: 823132164
};

const firmware155: FinalFirmware = {
  id: 24,
  name: "1.5.5",
  version: "1.5.5",
  se_firmware: 2,
  description: "",
  display_name: "",
  notes: "",
  perso: "perso_11",
  firmware: "nanos/1.5.5/fw_1.4.2/upgrade_1.5.5",
  firmware_key: "nanos/1.5.5/fw_1.4.2/upgrade_1.5.5_key",
  hash: "",
  distribution_ratio: null,
  exclude_by_default: false,
  osu_versions: [],
  date_creation: "2019-01-08T13:29:35.839258Z",
  date_last_modified: "2019-10-18T16:38:29.745993Z",
  device_versions: [10],
  mcu_versions: [6],
  application_versions: [],
  providers: [1, 4, 7, 9, 11, 12, 13],
  blocks: 20
};

export const parseInstalled = (installedDesc: string): InstalledItem[] =>
  installedDesc
    .split(",")
    .filter(Boolean)
    .map(a => {
      const trimmed = a.trim();
      const m = /(.*)\(outdated\)/.exec(trimmed);
      if (m) {
        const name = m[1].trim();
        return { name, updated: false, hash: "hash_" + name, blocks: 1 };
      }
      return {
        name: trimmed,
        updated: true,
        hash: "hash_" + trimmed,
        blocks: 1
      };
    });

export function mockListAppsResult(
  appDesc: string,
  installedDesc: string,
  deviceInfo: DeviceInfo
): ListAppsResult {
  const apps = appDesc
    .split(",")
    .map(a => a.trim())
    .filter(Boolean)
    .map((name, i) => {
      const dependency = getDirectDep(name);
      const o: ApplicationVersion = {
        id: i,
        app: i,
        name,
        version: "0.0.0",
        description: null,
        display_name: name,
        icon: "",
        picture: 0,
        notes: null,
        perso: "",
        hash: "hash_" + name,
        firmware: "firmware_" + name,
        bytes: (!dependency ? 10 : 1) * 4 * 1024,
        dependency,
        firmware_key: "",
        delete: "",
        delete_key: "",
        device_versions: [],
        se_firmware_final_versions: [],
        providers: [],
        date_creation: "",
        date_last_modified: ""
      };
      const currency = findCryptoCurrency(c => c.managerAppName === name);
      if (currency) {
        o.currencyId = currency.id;
      }
      return o;
    });
  const appByName = {};
  apps.forEach(app => {
    appByName[app.name] = app;
  });

  const installed = parseInstalled(installedDesc);

  return {
    appByName,
    appsListNames: apps.map(a => a.name),
    deviceInfo,
    deviceModelId: "nanoS",
    firmware: firmware155,
    installed,
    installedAvailable: true
  };
}

export const mockExecWithInstalledContext = (
  installedInitial: InstalledItem[]
): Exec => {
  let installed = installedInitial.slice(0);
  return (appOp: AppOp, targetId: string | number, app: ApplicationVersion) => {
    if (appOp.name !== app.name) {
      throw new Error("appOp.name must match app.name");
    }

    if (
      getDependencies(app.name).some(dep => installed.some(i => i.name === dep))
    ) {
      return throwError(new ManagerAppDepUninstallRequired(""));
    }

    if (appOp.type === "install") {
      const dep = getDirectDep(app.name);
      if (dep) {
        const depInstalled = installed.find(i => i.name === dep);
        if (!depInstalled || !depInstalled.updated) {
          return throwError(new ManagerAppDepInstallRequired(""));
        }
      }
    }

    switch (appOp.type) {
      case "install":
        if (!installed.some(i => i.name === appOp.name)) {
          installed = installed.concat({
            name: appOp.name,
            updated: true,
            blocks: 0,
            hash: ""
          });
        }
        break;

      case "uninstall":
        installed = installed.filter(a => a.name !== appOp.name);
        break;
    }

    return of({ progress: 0 }, { progress: 0.5 }, { progress: 1 });
  };
};
