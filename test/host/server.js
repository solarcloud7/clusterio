"use strict";
const assert = require("assert").strict;
const events = require("events");
const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("path");

const hostServer = require("@clusterio/host/dist/node/src/server");
const lib = require("@clusterio/lib");
const { wait } = lib;
const { testLines } = require("../lib/factorio/lines");
const { slowTest, requiresFactorio, factorioDir } = require("../integration");

// Resolved at module load (before any test changes cwd) so it survives process.chdir.
const realFactorioDir = path.resolve(factorioDir);

// A logger that records messages so a test can assert/print what was logged.
function recordingLogger(sink) {
	const handler = {
		get: (_t, prop) => (prop === "child"
			? () => new Proxy({}, handler)
			: (msg) => sink.push(`[${String(prop)}] ${msg}`)),
	};
	return new Proxy({}, handler);
}


describe("host/server", function() {
	describe("_getFactorioVersion()", function() {
		it("should get the version from a changelog", async function() {
			let version = await hostServer._getFactorioVersion(path.join("test", "file", "changelogs", "good"));
			assert.equal(version, "0.1.1");
		});
		it("should return null if unable to find the version", async function() {
			let version = await hostServer._getFactorioVersion(path.join("test", "file", "changelogs", "bad"));
			assert.equal(version, null);
		});
		it("should return null if file does not exist", async function() {
			let version = await hostServer._getFactorioVersion(path.join("test", "file", "changelogs", "not-exists"));
			assert.equal(version, null);
		});
	});

	describe("_versionOrder()", function() {
		it("should sort an array of versions", function() {
			let versions = ["1.2.3", "0.1.4", "0.1.2", "1.2.3", "0.1.5", "1.10.2"];
			versions.sort(hostServer._versionOrder);
			assert.deepEqual(
				versions,
				["1.10.2", "1.2.3", "1.2.3", "0.1.5", "0.1.4", "0.1.2"]
			);
		});
	});

	describe("_findVersion()", function() {
		describe("direct install", function() {
			it("should search given directory for latest Factorio install", async function() {
				const installDir = path.join("test", "file", "factorio", "0.1.2");
				const [dir, version] = await hostServer._findVersion(installDir, "latest");
				assert.equal(dir, path.join(installDir, "data"));
				assert.equal(version, "0.1.2");
			});
			it("should search given directory for given Factorio install", async function() {
				const installDir = path.join("test", "file", "factorio", "0.1.1");
				const [dir, version] = await hostServer._findVersion(installDir, "0.1.1");
				assert.equal(dir, path.join(installDir, "data"));
				assert.equal(version, "0.1.1");
			});
			it("should search given directory for partly given Factorio install", async function() {
				const installDir = path.join("test", "file", "factorio", "0.1.2");
				const [dir, version] = await hostServer._findVersion(installDir, "0.1");
				assert.equal(dir, path.join(installDir, "data"));
				assert.equal(version, "0.1.2");
			});
			it("should reject if the version does not match", async function() {
				let installDir = path.join("test", "file", "factorio", "0.1.1");
				await assert.rejects(
					hostServer._findVersion(installDir, "0.1.2"),
					new Error("Unable to find Factorio version 0.1.2")
				);
			});
		});
		describe("mutli install", function() {
			it("should reject if no factorio install with the given version was found", async function() {
				let installDir = path.join("test", "file", "factorio");
				await assert.rejects(
					hostServer._findVersion(installDir, "0.1.3"),
					new Error("Unable to find Factorio version 0.1.3")
				);
			});
			it("should search given directory for given Factorio install", async function() {
				const installDir = path.join("test", "file", "factorio");
				const [dir, version] = await hostServer._findVersion(installDir, "0.1.1");
				assert.equal(dir, path.join(installDir, "0.1.1", "data"));
				assert.equal(version, "0.1.1");
			});
			it("should search given directory for partly given Factorio install", async function() {
				const installDir = path.join("test", "file", "factorio");
				const [dir, version] = await hostServer._findVersion(installDir, "0.1");
				assert.equal(dir, path.join(installDir, "0.1.2", "data"));
				assert.equal(version, "0.1.2");
			});
			it("should reject if no factorio install with the given version was found", async function() {
				let installDir = path.join("test", "file", "factorio");
				await assert.rejects(
					hostServer._findVersion(installDir, "0.1.3"),
					new Error("Unable to find Factorio version 0.1.3")
				);
			});
			it("should reject if no factorio install was found", async function() {
				let installDir = path.join("test", "file");
				await assert.rejects(
					hostServer._findVersion(installDir, "0.0.0"),
					new Error(`Unable to find any Factorio install in ${installDir}`)
				);
			});
		});
	});

	describe("_listFactorioVersions()", function() {
		it("should list the version in a direct install", async function() {
			const installDir = path.join("test", "file", "factorio", "0.1.1");
			const installedVersions = await hostServer._listFactorioVersions(installDir);
			assert.deepEqual(installedVersions, {
				direct: true,
				versions: new Set(["0.1.1"]),
			});
		});
		it("should list all versions in a directory", async function() {
			const installDir = path.join("test", "file", "factorio");
			const installedVersions = await hostServer._listFactorioVersions(installDir);
			assert.deepEqual(installedVersions, {
				direct: false,
				versions: new Set(["0.1.1", "0.1.2"]),
			});
		});
	});

	describe("downloadAndExtractZip", function() {
		let _fetch;
		beforeEach(function() {
			_fetch = global.fetch;
		});
		afterEach(function() {
			global.fetch = _fetch;
		});

		it("works", async function() {
			slowTest(this);
			const url = "https://github.com/clusterio/clusterio/archive/refs/tags/v2.0.0-alpha.22.zip";
			const downloads = path.join("temp", "test", "downloads");
			await fs.rm(downloads, { force: true, recursive: true, maxRetries: 10 });
			await fs.mkdir(downloads, { recursive: true });
			await hostServer._downloadAndExtractZip(url, path.join(downloads, "zip"));
			await fs.access(path.join(downloads, "zip", "packages", "controller", "package.json"));
		});
		it("errors and bad status", async function() {
			global.fetch = () => ({ ok: false, status: -1, statusText: "Fetch called" });
			await assert.rejects(hostServer._downloadAndExtractZip("url does not matter"), /-1 Fetch called/);
		});
	});

	describe("downloadAndExtractTar", function() {
		let _fetch;
		beforeEach(function() {
			_fetch = global.fetch;
		});
		afterEach(function() {
			global.fetch = _fetch;
		});

		it("works", async function() {
			const url = "https://github.com/clusterio/clusterio/archive/refs/tags/v2.0.0-alpha.22.tar.gz";
			const downloads = path.join("temp", "test", "downloads");
			await fs.rm(downloads, { force: true, recursive: true, maxRetries: 10 });
			await fs.mkdir(downloads, { recursive: true });
			await hostServer._downloadAndExtractTar(url, path.join(downloads, "tar"));
			await fs.access(path.join(downloads, "tar", "packages", "controller", "package.json"));
		});
		it("errors and bad status", async function() {
			global.fetch = () => ({ ok: false, status: -1, statusText: "Fetch called" });
			await assert.rejects(hostServer._downloadAndExtractTar("url does not matter"), /-1 Fetch called/);
		});
	});

	describe("randomDynamicPort()", function() {
		it("should return a port number", function() {
			let port = hostServer._randomDynamicPort();
			assert.equal(typeof port, "number");
			assert(Number.isInteger(port));
			assert(0 <= port && port < 2**16);
		});

		it("should return a port number in the dynamic range", function() {
			function validate(port) {
				return (49152 <= port && port <= 65535);
			}
			for (let i=0; i < 20; i++) {
				assert(validate(hostServer._randomDynamicPort()));
			}
		});
	});

	describe("portAvailable()", function() {
		it("should return false for a port that is in use", async function() {
			let blocker = net.createServer();
			await new Promise(resolve => blocker.listen(0, "0.0.0.0", resolve));
			let port = blocker.address().port;
			try {
				assert.equal(await hostServer._portAvailable(port), false);
			} finally {
				await new Promise(resolve => blocker.close(resolve));
			}
		});

		it("should return true for a free port", async function() {
			// Let the OS hand out a free port, release it, then confirm it's reported free.
			let finder = net.createServer();
			await new Promise(resolve => finder.listen(0, "0.0.0.0", resolve));
			let port = finder.address().port;
			await new Promise(resolve => finder.close(resolve));
			assert.equal(await hostServer._portAvailable(port), true);
		});
	});

	describe("FactorioServer._assignRconPort()", function() {
		it("should move off a dynamic RCON port that is in use", async function() {
			let server = new hostServer.FactorioServer(
				path.join("test", "file", "factorio"), path.join("temp", "test", "server-rcon"), {}
			);
			let blocker = net.createServer();
			await new Promise(resolve => blocker.listen(0, "0.0.0.0", resolve));
			let busyPort = blocker.address().port;
			server.rconPort = busyPort; // force the auto-assigned port to the one in use
			try {
				await server._assignRconPort();
				assert.notEqual(server.rconPort, busyPort);
				assert.equal(await hostServer._portAvailable(server.rconPort), true);
			} finally {
				await new Promise(resolve => blocker.close(resolve));
			}
		});

		it("should leave an explicitly configured RCON port untouched", async function() {
			let blocker = net.createServer();
			await new Promise(resolve => blocker.listen(0, "0.0.0.0", resolve));
			let configuredPort = blocker.address().port;
			let server = new hostServer.FactorioServer(
				path.join("test", "file", "factorio"), path.join("temp", "test", "server-rcon-2"),
				{ rconPort: configuredPort }
			);
			try {
				await server._assignRconPort();
				// A configured port must not be changed even when it is in use.
				assert.equal(server.rconPort, configuredPort);
			} finally {
				await new Promise(resolve => blocker.close(resolve));
			}
		});
	});

	describe("generatePassword()", function() {
		it("should return a string", async function() {
			let password = await hostServer._generatePassword(1);
			assert.equal(typeof password, "string");
		});

		it("should return a string of the given length", async function() {
			let password = await hostServer._generatePassword(10);
			assert.equal(password.length, 10);
		});

		it("should contain only a-z, A-Z, 0-9", async function() {
			let password = await hostServer._generatePassword(10);
			assert(/^[a-zA-Z0-9]+$/.test(password), `${password} failed test`);
		});
	});

	describe("parseOutput()", function() {
		it("should parse the test lines", function() {
			for (let [line, reference] of testLines) {
				reference.source = "test";
				let output = hostServer._parseOutput(line, "test");
				assert.deepEqual(output, reference);
			}
		});
	});

	describe("RCON bind failure reporting", function() {
		it("should attribute a prefixed \"Can't bind socket\" error to the RCON port", function() {
			// Factorio reports an in-use RCON port with a "Hosting multiplayer game
			// failed: " prefix; the heuristic must still attribute it to the RCON port
			// rather than falling through to a generic "shut down with code 1".
			let server = new hostServer.FactorioServer(
				path.join("test", "file", "factorio"), path.join("temp", "test", "server-bind"), {}
			);
			server._handleOutput(Buffer.from(
				"   0.575 Error CommandLineMultiplayer.cpp:364: " +
				"Hosting multiplayer game failed: Can't bind socket: Address already in use"
			), "stdout");
			assert.deepEqual(server._unexpected, [
				"Factorio failed to bind to RCON port: " +
				"Hosting multiplayer game failed: Can't bind socket: Address already in use",
			]);
		});

		it("should attribute the Windows form of the bind error to the RCON port", function() {
			// On Windows the suffix is a WSA error code rather than "Address already in use".
			let server = new hostServer.FactorioServer(
				path.join("test", "file", "factorio"), path.join("temp", "test", "server-bind-win"), {}
			);
			server._handleOutput(Buffer.from(
				"   1.318 Error CommandLineMultiplayer.cpp:355: Hosting multiplayer game failed: " +
				"Can't bind socket: Error code 10013, An attempt was made to access a socket " +
				"in a way forbidden by its access permissions."
			), "stdout");
			assert.equal(server._unexpected.length, 1);
			assert(
				server._unexpected[0].startsWith("Factorio failed to bind to RCON port:"),
				`unexpected was ${JSON.stringify(server._unexpected)}`
			);
		});
	});

	describe("RCON port handling with a real Factorio server (#923)", function() {
		requiresFactorio(this);
		const writeDir = path.resolve(path.join("temp", "test", "rcon-923"));
		const saveName = "rcon-923";
		// Written under the logs dir that CI uploads as an artifact, so the real
		// behaviour can be inspected after the run.
		const proofLog = path.resolve(path.join("temp", "test", "logs", "rcon-923-proof.log"));

		function occupy(port) {
			return new Promise((resolve, reject) => {
				let s = net.createServer();
				s.once("error", reject);
				s.listen(port, "0.0.0.0", () => resolve(s));
			});
		}

		before(async function() {
			this.timeout(120000);
			slowTest(this);
			await fs.rm(writeDir, { force: true, recursive: true, maxRetries: 10 });
			await fs.mkdir(writeDir, { recursive: true });
			await fs.mkdir(path.dirname(proofLog), { recursive: true });
			let server = new hostServer.FactorioServer(realFactorioDir, writeDir, {});
			await server.init();
			await server.create(saveName);
		});

		it("re-rolls an in-use dynamic RCON port and still starts", async function() {
			this.timeout(120000);
			slowTest(this);
			let blocker = await occupy(0);
			let busyPort = blocker.address().port;
			let logged = [];
			let server = new hostServer.FactorioServer(realFactorioDir, writeDir, { logger: recordingLogger(logged) });
			server.rconPort = busyPort; // force the auto-assigned dynamic port onto the busy one
			try {
				await server.start(`${saveName}.zip`);
				assert.notEqual(server.rconPort, busyPort, "RCON port should have been re-rolled off the busy one");
				// Recorded to the uploaded logs artifact so the behaviour is inspectable.
				await fs.appendFile(proofLog,
					`#923 re-roll: forced busy ${busyPort} -> server started on ${server.rconPort}; ` +
					`log=${JSON.stringify(logged.filter(l => /RCON port/.test(l)))}\n`
				);
			} finally {
				await server.stop().catch(() => {});
				await new Promise(resolve => blocker.close(resolve));
			}
		});

		it("reports an in-use configured RCON port as an RCON bind failure", async function() {
			this.timeout(120000);
			slowTest(this);
			let blocker = await occupy(0);
			let busyPort = blocker.address().port;
			let server = new hostServer.FactorioServer(realFactorioDir, writeDir, { rconPort: busyPort });
			try {
				let failure = new Promise(resolve => server.once("error", err => resolve(err.message)));
				server.start(`${saveName}.zip`).catch(() => {});
				let message = await failure;
				await fs.appendFile(proofLog, `#923 reporting: host reported -> ${message}\n`);
				assert(/failed to bind to RCON port/.test(message), `expected RCON bind failure, got: ${message}`);
			} finally {
				await server.stop().catch(() => {});
				await new Promise(resolve => blocker.close(resolve));
			}
		});
	});

	describe("class FactorioServer", function() {
		let writePath = path.join("temp", "test", "server");
		let server = new hostServer.FactorioServer(path.join("test", "file", "factorio"), writePath, {});

		describe("constructor()", function() {
			it("should handle dashes in write path with strapPaths enabled", function() {
				// eslint-disable-next-line no-new
				new hostServer.FactorioServer(
					path.join("test", "file", "factorio"),
					path.join("temp", "test", "server-1"),
					{ stripPaths: true }
				);
			});
		});

		describe(".init()", function() {
			it("should not throw on first call", async function() {
				await server.init();
			});

			it("should throw if called twice", async function() {
				await assert.rejects(server.init(), new Error("Expected state new but state is init"));
			});
		});

		describe(".version", function() {
			it("should return the version detected", function() {
				assert.equal(server.version, "0.1.2");
			});
		});

		describe("._handleIpc()", function() {
			it("should emit the correct ipc event", async function() {
				let waiter = events.once(server, "ipc-channel");
				await server._handleIpc(Buffer.from('\f$ipc:channel?j"value"'));
				let result = await waiter;
				assert.equal(result[0], "value");
			});
			it("should handle special characters in channel name", async function() {
				let waiter = events.once(server, "ipc-$ ?\x00\x0a:");
				await server._handleIpc(Buffer.from('\f$ipc:$ \\x3f\\x00\\x0a:?j"value"'));
				let result = await waiter;
				assert.equal(result[0], "value");
			});
			it("should throw on malformed ipc line", async function() {
				await assert.rejects(
					server._handleIpc(Buffer.from("\f$ipc:blah")),
					new Error('Malformed IPC line "\f$ipc:blah"')
				);
			});
			it("should throw on unknown type", async function() {
				await assert.rejects(
					server._handleIpc(Buffer.from("\f$ipc:channel??")),
					new Error("Unknown IPC type '?'")
				);
			});
			it("should throw on unknown file type", async function() {
				await assert.rejects(
					server._handleIpc(Buffer.from("\f$ipc:channel?ffoo.invalid")),
					new Error("Unknown IPC file format 'invalid'")
				);
			});
			it("should throw on file name with slash", async function() {
				await assert.rejects(
					server._handleIpc(Buffer.from("\f$ipc:channel?fa/b")),
					new Error("Invalid IPC file name 'a/b'")
				);
			});
			it("should load and delete json file", async function() {
				await fs.mkdir(server.writePath("script-output"), { recursive: true });
				let filePath = server.writePath("script-output", "data.json");
				await fs.writeFile(filePath, '{"data":"spam"}');
				let waiter = events.once(server, "ipc-channel");
				await server._handleIpc(Buffer.from("\f$ipc:channel?fdata.json"));
				let result = await waiter;
				assert.deepEqual(result[0], { "data": "spam" });
				await assert.rejects(fs.access(filePath), "File was not deleted");
			});
		});

		describe(".stop()", function() {
			it("should handle server quitting on its own during stop", async function() {
				server.shutdownTimeoutMs = 20;
				server._server = new events.EventEmitter();
				server._server.kill = () => true;
				server._state = "running";
				server._rconReady = false;
				server._rconClient = {
					async sendRcon() { },
					async end() {
						server._rconClient = null;
					},
				};
				server._watchExit();

				const stop = server.stop();
				stop.catch(() => {});
				process.nextTick(() => {
					server.emit("rcon-ready");
					server._server.emit("exit");
				});

				await stop;
				await wait(21); // Wait until after shutdown timeout
			});
		});

		describe(".checkForUpdates()", function() {
			let _fetch;
			let fetchCalledWith;
			let _platform = process.platform;
			beforeEach(function() {
				_fetch = global.fetch;
				fetchCalledWith = null;
				global.fetch = async function(url) {
					fetchCalledWith = url;
					return {
						ok: false,
						status: -1,
						statusText: "Fetch called",
					};
				};
			});
			afterEach(function() {
				global.fetch = _fetch;
				server._factorioDir = path.join("test", "file", "factorio");
				Object.defineProperty(process, "platform", {
					value: _platform,
				});
			});

			for (const [suite, target] of [
				["full version", "0.1.1"],
				["partial version", "0.1"],
				["latest version", "latest"],
			]) {
				/* eslint-disable no-loop-func */
				describe(suite, function() {
					it("should do nothing when there are no versions", async function() {
						server._factorioDir = path.join("test", "file", "factorio");
						server._targetVersion = target;
						await server.checkForUpdates([]);

						assert.equal(fetchCalledWith, null);
					});
					if (target !== "latest") {
						it("should do nothing when no version matches", async function() {
							server._factorioDir = path.join("test", "file", "factorio");
							server._targetVersion = target;
							await server.checkForUpdates([{
								stable: true,
								version: "0.2.1",
								headlessUrl: "test1",
							}, {
								stable: false,
								version: "0.2.0",
								headlessUrl: "test2",
							}]);

							assert.equal(fetchCalledWith, null);
						});
					}
					it("should do nothing when there is no newer version", async function() {
						server._factorioDir = path.join("test", "file", "factorio");
						server._targetVersion = target;
						await server.checkForUpdates([{
							stable: true,
							version: "0.1.1",
							headlessUrl: "test1",
						}, {
							stable: false,
							version: "0.1.0",
							headlessUrl: "test2",
						}]);

						assert.equal(fetchCalledWith, null);
					});
					it("should do nothing for direct installs", async function() {
						server._factorioDir = path.join("test", "file", "factorio", "0.1.1");
						server._targetVersion = target === "0.1.1" ? "0.1.5" : target;
						await server.checkForUpdates([{
							stable: true,
							version: "0.1.5",
							headlessUrl: "test1",
						}, {
							stable: true,
							version: "0.1.1",
							headlessUrl: "test1",
						}, {
							stable: false,
							version: "0.1.0",
							headlessUrl: "test2",
						}]);

						assert.equal(fetchCalledWith, null);
					});
					it("should do nothing when on windows", async function() {
						let logLine = null;
						server._logger = { info: line => { logLine = line; } };
						Object.defineProperty(process, "platform", { value: "win32" });

						server._factorioDir = path.join("test", "file", "factorio");
						server._targetVersion = target === "0.1.1" ? "0.1.5" : target;
						await server.checkForUpdates([{
							stable: true,
							version: "0.1.5",
							headlessUrl: "test1",
						}, {
							stable: true,
							version: "0.1.1",
							headlessUrl: "test2",
						}, {
							stable: false,
							version: "0.1.0",
							headlessUrl: "test3",
						}]);

						assert.equal(fetchCalledWith, null);
						assert.ok(logLine !== null);
						assert.ok(logLine.endsWith("but must be manually downloaded"));
					});
					it("should do attempt to download on linux", async function() {
						let logLine = null;
						server._logger = { info: line => { logLine = line; } };
						Object.defineProperty(process, "platform", { value: "linux" });

						server._factorioDir = path.join("test", "file", "factorio");
						server._targetVersion = target === "0.1.1" ? "0.1.5" : target;
						await assert.rejects(server.checkForUpdates([{
							stable: true,
							version: "0.1.5",
							headlessUrl: "test1",
						}, {
							stable: true,
							version: "0.1.1",
							headlessUrl: "test2",
						}, {
							stable: false,
							version: "0.1.0",
							headlessUrl: "test3",
						}]), new Error("Failed to fetch test1: -1 Fetch called"));

						assert.equal(fetchCalledWith, "test1");
						assert.ok(logLine !== null);
						assert.ok(logLine.endsWith("starting download..."));
					});
				});
				/* eslint-enable no-loop-func */
			}
			it("should download a version correctly (live api)", async function() {
				slowTest(this);
				if (_platform !== "linux") {
					this.skip();
				}

				server._factorioDir = path.join("test", "file", "factorioDownload");
				server._targetVersion = "latest";
				global.fetch = _fetch;
				await fs.rm(server._factorioDir, { force: true, recursive: true, maxRetries: 10 });
				await fs.mkdir(server._factorioDir, { recursive: true });
				await server.checkForUpdates([{
					stable: true,
					version: "2.0.73",
					headlessUrl: "https://www.factorio.com/get-download/2.0.73/headless/linux64",
				}]);
			});
		});
	});
});
