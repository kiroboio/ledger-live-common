// @flow
/* eslint-disable no-for-in */
/* eslint-disable no-params-reassign */
/* eslint-disable new-cap */

import invariant from "invariant";
import { log } from "@ledgerhq/logs";
import { NotEnoughBalance } from "@ledgerhq/errors/lib";
import { deserializeError, serializeError } from "@ledgerhq/errors/lib/helpers";
import { reflect } from "../types";
import type { Core, CoreStatics } from "../types";
import { setLoadCoreImplementation } from "../access";
import { setRemapLibcoreErrorsImplementation } from "../errors";
import { getEnv } from "../../env";
import network from "../../network";

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

export default (arg: {
  // the actual @ledgerhq/ledger-core lib or a function that returns it
  lib: any,
  dbPath: string,
  dbPassword?: string
}) => {
  let lib;
  const lazyLoad = () => {
    if (lib) return;
    if (typeof arg.lib === "function") {
      lib = arg.lib();
    } else {
      lib = arg.lib;
    }
  };
  const { dbPath } = arg;
  const dbPassword =
    typeof arg.dbPassword === "undefined"
      ? getEnv("LIBCORE_PASSWORD")
      : arg.dbPassword;

  const loadCore = (): Promise<Core> => {
    lazyLoad();

    const MAX_RANDOM = 2684869021;

    const lcore = new lib.NJSLedgerCore();
    const stringVersion = lcore.getStringVersion();
    const sqlitePrefix = `v${stringVersion.split(".")[0]}`;

    const hexToBytes = str =>
      Array.from(Buffer.from(str.startsWith("0x") ? str.slice(2) : str, "hex"));
    const bytesToHex = buf => Buffer.from(buf).toString("hex");

    const bytesArrayToString = (bytesArray = []) =>
      Buffer.from(bytesArray).toString();

    const stringToBytesArray = str => Array.from(Buffer.from(str));

    const NJSExecutionContextImpl = {
      execute: runnable => {
        try {
          const runFunction = () => runnable.run();
          setImmediate(runFunction);
        } catch (e) {
          log("libcore-Error", String(e));
        }
      },
      delay: (runnable, ms) => setTimeout(() => runnable.run(), ms)
    };

    const ThreadContexts = {};

    const getSerialExecutionContext = name => {
      let currentContext = ThreadContexts[name];
      if (!currentContext) {
        currentContext = new lib.NJSExecutionContext(NJSExecutionContextImpl);
        ThreadContexts[name] = currentContext;
      }
      return currentContext;
    };

    const getMainExecutionContext = () => getSerialExecutionContext("main");

    const NJSThreadDispatcher = new lib.NJSThreadDispatcher({
      contexts: ThreadContexts,
      getThreadPoolExecutionContext: name => getSerialExecutionContext(name),
      getMainExecutionContext,
      getSerialExecutionContext,
      newLock: () => {
        log(
          "libcore-Warn",
          "libcore NJSThreadDispatcher: newLock: Not implemented"
        );
      }
    });

    NJSThreadDispatcher.getMainExecutionContext = getMainExecutionContext;

    function createHttpConnection(res, libcoreError) {
      if (!res) {
        return null;
      }
      const headersMap = new Map();
      Object.keys(res.headers).forEach(key => {
        if (typeof res.headers[key] === "string") {
          headersMap.set(key, res.headers[key]);
        }
      });
      const NJSHttpUrlConnectionImpl = {
        getStatusCode: () => Number(res.status),
        getStatusText: () => res.statusText,
        getHeaders: () => headersMap,
        readBody: () => ({
          error: libcoreError,
          data: stringToBytesArray(res.data)
        })
      };
      return new lib.NJSHttpUrlConnection(NJSHttpUrlConnectionImpl);
    }

    const NJSHttpClient = new lib.NJSHttpClient({
      execute: async r => {
        const method = r.getMethod();
        const headersMap = r.getHeaders();
        const url = r.getUrl();
        let data = r.getBody();
        const headers = {};
        headersMap.forEach((v, k) => {
          headers[k] = v;
        });
        let res;
        const param: Object = {
          method: lib.METHODS[method],
          url,
          headers,
          validateStatus: status =>
            // FIXME in future, everything should passthrough libcore
            // for now as we need to have the server error we will only pass-in 2xx and 404
            (status >= 200 && status < 300) || status === 404,
          // the default would parse the request, we want to preserve the string
          transformResponse: data => data
        };

        if (Array.isArray(data)) {
          if (data.length === 0) {
            data = null;
          } else {
            // we transform back to a string
            data = bytesArrayToString(data);
          }
        }
        if (data) {
          param.data = data;
          if (!headers["Content-Type"]) {
            headers["Content-Type"] = "application/json";
          }
        }
        try {
          res = await network(param);
          const urlConnection = createHttpConnection(res, null);
          r.complete(urlConnection, null);
        } catch (err) {
          const libcoreError = {
            code: lib.ERROR_CODE.HTTP_ERROR,
            message: JSON.stringify(
              serializeError({
                message: err.message,
                name: err.name
              })
            ),
            stack: err.stack
          };
          const urlConnection = createHttpConnection(res, libcoreError);
          r.complete(urlConnection, libcoreError);
        }
      }
    });

    const NJSWebSocketClient = new lib.NJSWebSocketClient({
      connect: (url, connection) => {
        connection.OnConnect();
      },
      send: (connection, data) => {
        connection.OnMessage(data);
      },
      disconnect: connection => {
        connection.OnClose();
      }
    });

    const NJSLogPrinter = new lib.NJSLogPrinter({
      context: {},
      printError: message => log("libcore-Error", message),
      printInfo: message => log("libcore-Info", message),
      printDebug: message => log("libcore-Debug", message),
      printWarning: message => log("libcore-Warning", message),
      printApdu: message => log("libcore-Apdu", message),
      printCriticalError: message => log("libcore-CriticalError", message),
      getContext: () => new lib.NJSExecutionContext(NJSExecutionContextImpl)
    });

    const NJSRandomNumberGenerator = new lib.NJSRandomNumberGenerator({
      getRandomBytes: size =>
        Array.from(Buffer.from(crypto.randomBytes(size), "hex")),
      getRandomInt: () => Math.random() * MAX_RANDOM,
      getRandomLong: () => Math.random() * MAX_RANDOM * MAX_RANDOM
    });

    const NJSDatabaseBackend = new lib.NJSDatabaseBackend();
    const NJSDynamicObject = new lib.NJSDynamicObject();

    let walletPoolInstance = null;

    const instanciateWalletPool = () => {
      try {
        fs.mkdirSync(dbPath);
      } catch (err) {
        if (err.code !== "EEXIST") {
          throw err;
        }
      }

      const NJSPathResolver = new lib.NJSPathResolver({
        resolveLogFilePath: pathToResolve => {
          const hash = pathToResolve.replace(/\//g, "__");
          return path.resolve(dbPath, `./log_file_${sqlitePrefix}_${hash}`);
        },
        resolvePreferencesPath: pathToResolve => {
          const hash = pathToResolve.replace(/\//g, "__");
          return path.resolve(dbPath, `./preferences_${sqlitePrefix}_${hash}`);
        },
        resolveDatabasePath: pathToResolve => {
          const hash = pathToResolve.replace(/\//g, "__");
          return path.resolve(dbPath, `./database_${sqlitePrefix}_${hash}`);
        }
      });

      walletPoolInstance = new lib.NJSWalletPool(
        "ledgerlive",
        dbPassword,
        NJSHttpClient,
        NJSWebSocketClient,
        NJSPathResolver,
        NJSLogPrinter,
        NJSThreadDispatcher,
        NJSRandomNumberGenerator,
        NJSDatabaseBackend,
        NJSDynamicObject
      );

      return walletPoolInstance;
    };

    const getPoolInstance = () => {
      if (!walletPoolInstance) {
        instanciateWalletPool();
      }
      invariant(walletPoolInstance, "can't initialize walletPoolInstance");
      return walletPoolInstance;
    };

    const mappings = {};
    Object.keys(lib).forEach(k => {
      if (k.startsWith("NJS")) {
        mappings[k.slice(3)] = lib[k];
      }
    });

    const wrappers = {
      hex: hexToBytes
    };
    const unwrappers = {
      hex: bytesToHex
    };

    function wrapResult(id, value) {
      if (!value || !id) return value;
      if (Array.isArray(id)) {
        const [actualId] = id;
        return value.map(a => wrapResult(actualId, a));
      }
      if (id in unwrappers) {
        return unwrappers[id](value);
      }
      const Clz = mappings[id];
      if (!Clz) {
        return value;
      }
      if (value instanceof Clz) return value;
      return new Clz(value);
    }

    function unwrapArg(id, value) {
      if (!value || !id) return value;
      if (Array.isArray(id)) {
        const [actualId] = id;
        return value.map(v => unwrapArg(actualId, v));
      }
      if (id in wrappers) {
        return wrappers[id](value);
      }
      return value;
    }

    reflect((id, spec) => {
      const { methods, statics } = spec;
      let m;
      if (spec.njsUsesPlainObject) {
        // In that case we need to create a class and abstract out the methods
        m = function constructor(data) {
          Object.assign(this, data);
        };
        mappings[id] = m;
      } else {
        m = mappings[id];
        if (!m) {
          return;
        }
      }

      if (statics) {
        Object.keys(statics).forEach(method => {
          const {
            njsInstanciateClass,
            njsBuggyMethodIsNotStatic,
            params
          } = statics[method];
          if (njsInstanciateClass) {
            m[method] = function met(...vargs) {
              if (process.env.VERBOSE_LIBCORE_CALL) {
                log("libcore-call", id + "." + method, vargs);
              }
              const args = njsInstanciateClass.map(arg => {
                if (typeof arg === "object") {
                  const o = {};
                  for (const k in arg) {
                    const index = arg[k];
                    o[k] = unwrapArg(params && params[index], vargs[index]);
                  }
                  return o;
                }
                return arg;
              });
              return new m(...args);
            };
          } else if (njsBuggyMethodIsNotStatic) {
            // There is a bug in the node bindings that don't expose the static functions
            m[method] = (...args) => {
              if (process.env.VERBOSE_LIBCORE_CALL) {
                log("libcore-call", id + "." + method, args);
              }
              const constructorArgs =
                typeof njsBuggyMethodIsNotStatic === "function"
                  ? njsBuggyMethodIsNotStatic(args)
                  : args;
              return new m(...constructorArgs)[method](...args);
            };
          }
        });
      }

      if (methods) {
        Object.keys(methods).forEach(method => {
          const { njsField, params, returns, nodejsNotAvailable } = methods[
            method
          ];
          if (nodejsNotAvailable) return;
          if (njsField) {
            m.prototype[method] = function met() {
              if (process.env.VERBOSE_LIBCORE_CALL) {
                log("libcore-call", id + "#" + method);
              }
              const value = this[njsField];
              const Cls =
                typeof returns === "string" && returns in mappings
                  ? mappings[returns]
                  : null;
              if (Cls && !(value instanceof Cls)) {
                const inst = new Cls(value);
                return inst;
              }
              return wrapResult(returns, value);
            };
          } else {
            const f = m.prototype[method];
            if (!f) {
              console.warn(`no such method '${method}' in ${id}`);
              return;
            }
            m.prototype[method] = async function met(...a) {
              if (process.env.VERBOSE_LIBCORE_CALL) {
                log("libcore-call", id + "#" + method, a);
              }
              const args = params
                ? a.map((value, i) => unwrapArg(params[i], value))
                : a;
              const result = await f.apply(this, args);
              return wrapResult(returns, result);
            };
          }
        });
      }
    });

    // other NodeJS bindings specific code

    const eventBusSubscribe = mappings.EventBus.prototype.subscribe;
    mappings.EventBus.prototype.subscribe = function subscribe(
      executionContext,
      receiver_
    ) {
      const receiver = receiver_;
      return new Promise((resolve, reject) => {
        receiver._resolve = resolve;
        receiver._reject = reject;
        eventBusSubscribe.call(this, executionContext, receiver);
      });
    };

    mappings.EventReceiver.newInstance = () => {
      const receiver = new mappings.EventReceiver({
        onEvent: e => {
          const code = e.getCode();
          if (
            code === lib.EVENT_CODE.UNDEFINED ||
            code === lib.EVENT_CODE.SYNCHRONIZATION_FAILED
          ) {
            const payload = e.getPayload();
            const message = (
              (payload && payload.getString("EV_SYNC_ERROR_MESSAGE")) ||
              "Sync failed"
            ).replace(" (EC_PRIV_KEY_INVALID_FORMAT)", "");
            try {
              receiver._reject(deserializeError(JSON.parse(message)));
            } catch (_e) {
              receiver._reject(message);
            }
            return;
          }
          if (
            code === lib.EVENT_CODE.SYNCHRONIZATION_SUCCEED ||
            code ===
              lib.EVENT_CODE.SYNCHRONIZATION_SUCCEED_ON_PREVIOUSLY_EMPTY_ACCOUNT
          ) {
            receiver._resolve();
          }
        }
      });
      return receiver;
    };

    // $FlowFixMe
    const cs: CoreStatics = mappings;

    const core: Core = {
      ...cs,
      flush: () => Promise.resolve(),
      getPoolInstance,
      getThreadDispatcher: () => NJSThreadDispatcher
    };

    return Promise.resolve(core);
  };

  const remapLibcoreErrors = (input: Error) => {
    lazyLoad();
    const e: mixed = input;
    if (e && typeof e === "object") {
      if (typeof e.code === "number") {
        if (e.code === lib.ERROR_CODE.NOT_ENOUGH_FUNDS) {
          return new NotEnoughBalance();
        } else {
          // re-deserialize error if it was a serialized error
          try {
            const m = input.message.match(/[^{]*({.*}).*/);
            if (m) {
              const json = JSON.parse(m[1]);
              if (json.name) {
                return deserializeError(json);
              }
            }
          } catch (_e) {}
          return input;
        }
      }
    }
    return input;
  };

  setLoadCoreImplementation(loadCore);
  setRemapLibcoreErrorsImplementation(remapLibcoreErrors);
};
