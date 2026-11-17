import { beforeAll, setDefaultTimeout } from "bun:test";
import localforage from "localforage";
import "./localforage-bun-memory";

setDefaultTimeout(30_000);

// Production modules configure the default instance before tests install spies.
beforeAll(async () => { await localforage.ready(); });
