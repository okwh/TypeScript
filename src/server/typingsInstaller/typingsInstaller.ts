namespace ts.server.typingsInstaller {
    interface NpmConfig {
        devDependencies: MapLike<any>;
    }

    interface NpmLock {
        dependencies: { [packageName: string]: { version: string } };
    }

    export interface Log {
        isEnabled(): boolean;
        writeLine(text: string): void;
    }

    const nullLog: Log = {
        isEnabled: () => false,
        writeLine: noop
    };

    function typingToFileName(cachePath: string, packageName: string, installTypingHost: InstallTypingHost, log: Log): string | undefined {
        try {
            const result = resolveModuleName(packageName, combinePaths(cachePath, "index.d.ts"), { moduleResolution: ModuleResolutionKind.NodeJs }, installTypingHost);
            return result.resolvedModule && result.resolvedModule.resolvedFileName;
        }
        catch (e) {
            if (log.isEnabled()) {
                log.writeLine(`Failed to resolve ${packageName} in folder '${cachePath}': ${(<Error>e).message}`);
            }
            return undefined;
        }
    }

    /*@internal*/
    export function installNpmPackages(npmPath: string, tsVersion: string, packageNames: string[], install: (command: string) => boolean) {
        let hasError = false;
        for (let remaining = packageNames.length; remaining > 0;) {
            const result = getNpmCommandForInstallation(npmPath, tsVersion, packageNames, remaining);
            remaining = result.remaining;
            hasError = install(result.command) || hasError;
        }
        return hasError;
    }

    /*@internal*/
    export function getNpmCommandForInstallation(npmPath: string, tsVersion: string, packageNames: string[], remaining: number) {
        const sliceStart = packageNames.length - remaining;
        let command: string, toSlice = remaining;
        while (true) {
            command = `${npmPath} install --ignore-scripts ${(toSlice === packageNames.length ? packageNames : packageNames.slice(sliceStart, sliceStart + toSlice)).join(" ")} --save-dev --user-agent="typesInstaller/${tsVersion}"`;
            if (command.length < 8000) {
                break;
            }

            toSlice = toSlice - Math.floor(toSlice / 2);
        }
        return { command, remaining: remaining - toSlice };
    }

    export type RequestCompletedAction = (success: boolean) => void;
    interface PendingRequest {
        requestId: number;
        packageNames: string[];
        cwd: string;
        onRequestCompleted: RequestCompletedAction;
    }

    function isPackageOrBowerJson(fileName: string) {
        const base = getBaseFileName(fileName);
        return base === "package.json" || base === "bower.json";
    }

    function getDirectoryExcludingNodeModulesOrBowerComponents(f: string) {
        const indexOfNodeModules = f.indexOf("/node_modules/");
        const indexOfBowerComponents = f.indexOf("/bower_components/");
        const subStrLength = indexOfNodeModules === -1 || indexOfBowerComponents === -1 ?
            Math.max(indexOfNodeModules, indexOfBowerComponents) :
            Math.min(indexOfNodeModules, indexOfBowerComponents);
        return subStrLength === -1 ? f : f.substr(0, subStrLength);
    }

    type ProjectWatchers = Map<FileWatcher> & { isInvoked?: boolean; };

    export abstract class TypingsInstaller {
        private readonly packageNameToTypingLocation: Map<JsTyping.CachedTyping> = createMap<JsTyping.CachedTyping>();
        private readonly missingTypingsSet: Map<true> = createMap<true>();
        private readonly knownCachesSet: Map<true> = createMap<true>();
        private readonly projectWatchers = createMap<ProjectWatchers>();
        private safeList: JsTyping.SafeList | undefined;
        readonly pendingRunRequests: PendingRequest[] = [];
        private readonly toCanonicalFileName: GetCanonicalFileName;
        private readonly globalCacheCanonicalPackageJsonPath: string;

        private installRunCount = 1;
        private inFlightRequestCount = 0;

        abstract readonly typesRegistry: Map<MapLike<string>>;

        constructor(
            protected readonly installTypingHost: InstallTypingHost,
            private readonly globalCachePath: string,
            private readonly safeListPath: Path,
            private readonly typesMapLocation: Path,
            private readonly throttleLimit: number,
            protected readonly log = nullLog) {
            this.toCanonicalFileName = createGetCanonicalFileName(installTypingHost.useCaseSensitiveFileNames);
            this.globalCacheCanonicalPackageJsonPath = combinePaths(this.toCanonicalFileName(globalCachePath), "package.json");
            if (this.log.isEnabled()) {
                this.log.writeLine(`Global cache location '${globalCachePath}', safe file path '${safeListPath}', types map path ${typesMapLocation}`);
            }
            this.processCacheLocation(this.globalCachePath);
        }

        closeProject(req: CloseProject) {
            this.closeWatchers(req.projectName);
        }

        private closeWatchers(projectName: string): void {
            if (this.log.isEnabled()) {
                this.log.writeLine(`Closing file watchers for project '${projectName}'`);
            }
            const watchers = this.projectWatchers.get(projectName);
            if (!watchers) {
                if (this.log.isEnabled()) {
                    this.log.writeLine(`No watchers are registered for project '${projectName}'`);
                }
                return;
            }
            clearMap(watchers, closeFileWatcher);
            this.projectWatchers.delete(projectName);

            if (this.log.isEnabled()) {
                this.log.writeLine(`Closing file watchers for project '${projectName}' - done.`);
            }
        }

        install(req: DiscoverTypings) {
            if (this.log.isEnabled()) {
                this.log.writeLine(`Got install request ${JSON.stringify(req)}`);
            }

            // load existing typing information from the cache
            if (req.cachePath) {
                if (this.log.isEnabled()) {
                    this.log.writeLine(`Request specifies cache path '${req.cachePath}', loading cached information...`);
                }
                this.processCacheLocation(req.cachePath);
            }

            if (this.safeList === undefined) {
                this.initializeSafeList();
            }
            const discoverTypingsResult = JsTyping.discoverTypings(
                this.installTypingHost,
                this.log.isEnabled() ? (s => this.log.writeLine(s)) : undefined,
                req.fileNames,
                req.projectRootPath,
                this.safeList!,
                this.packageNameToTypingLocation,
                req.typeAcquisition,
                req.unresolvedImports,
                this.typesRegistry);

            if (this.log.isEnabled()) {
                this.log.writeLine(`Finished typings discovery: ${JSON.stringify(discoverTypingsResult)}`);
            }

            // start watching files
            this.watchFiles(req.projectName, discoverTypingsResult.filesToWatch, req.projectRootPath);

            // install typings
            if (discoverTypingsResult.newTypingNames.length) {
                this.installTypings(req, req.cachePath || this.globalCachePath, discoverTypingsResult.cachedTypingPaths, discoverTypingsResult.newTypingNames);
            }
            else {
                this.sendResponse(this.createSetTypings(req, discoverTypingsResult.cachedTypingPaths));
                if (this.log.isEnabled()) {
                    this.log.writeLine(`No new typings were requested as a result of typings discovery`);
                }
            }
        }

        private initializeSafeList() {
            // Prefer the safe list from the types map if it exists
            if (this.typesMapLocation) {
                const safeListFromMap = JsTyping.loadTypesMap(this.installTypingHost, this.typesMapLocation);
                if (safeListFromMap) {
                    this.log.writeLine(`Loaded safelist from types map file '${this.typesMapLocation}'`);
                    this.safeList = safeListFromMap;
                    return;
                }
                this.log.writeLine(`Failed to load safelist from types map file '${this.typesMapLocation}'`);
            }
            this.safeList = JsTyping.loadSafeList(this.installTypingHost, this.safeListPath);
        }

        private processCacheLocation(cacheLocation: string) {
            if (this.log.isEnabled()) {
                this.log.writeLine(`Processing cache location '${cacheLocation}'`);
            }
            if (this.knownCachesSet.has(cacheLocation)) {
                if (this.log.isEnabled()) {
                    this.log.writeLine(`Cache location was already processed...`);
                }
                return;
            }
            const packageJson = combinePaths(cacheLocation, "package.json");
            const packageLockJson = combinePaths(cacheLocation, "package-lock.json");
            if (this.log.isEnabled()) {
                this.log.writeLine(`Trying to find '${packageJson}'...`);
            }
            if (this.installTypingHost.fileExists(packageJson) && this.installTypingHost.fileExists(packageLockJson)) {
                const npmConfig = <NpmConfig>JSON.parse(this.installTypingHost.readFile(packageJson)!); // TODO: GH#18217
                const npmLock = <NpmLock>JSON.parse(this.installTypingHost.readFile(packageLockJson)!); // TODO: GH#18217
                if (this.log.isEnabled()) {
                    this.log.writeLine(`Loaded content of '${packageJson}': ${JSON.stringify(npmConfig)}`);
                    this.log.writeLine(`Loaded content of '${packageLockJson}'`);
                }
                if (npmConfig.devDependencies && npmLock.dependencies) {
                    for (const key in npmConfig.devDependencies) {
                        if (!hasProperty(npmLock.dependencies, key)) {
                            // if package in package.json but not package-lock.json, skip adding to cache so it is reinstalled on next use
                            continue;
                        }
                        // key is @types/<package name>
                        const packageName = getBaseFileName(key);
                        if (!packageName) {
                            continue;
                        }
                        const typingFile = typingToFileName(cacheLocation, packageName, this.installTypingHost, this.log);
                        if (!typingFile) {
                            this.missingTypingsSet.set(packageName, true);
                            continue;
                        }
                        const existingTypingFile = this.packageNameToTypingLocation.get(packageName);
                        if (existingTypingFile) {
                            if (existingTypingFile.typingLocation === typingFile) {
                                continue;
                            }

                            if (this.log.isEnabled()) {
                                this.log.writeLine(`New typing for package ${packageName} from '${typingFile}' conflicts with existing typing file '${existingTypingFile}'`);
                            }
                        }
                        if (this.log.isEnabled()) {
                            this.log.writeLine(`Adding entry into typings cache: '${packageName}' => '${typingFile}'`);
                        }
                        const info = getProperty(npmLock.dependencies, key);
                        const version = info && info.version;
                        const semver = Semver.parse(version!); // TODO: GH#18217
                        const newTyping: JsTyping.CachedTyping = { typingLocation: typingFile, version: semver };
                        this.packageNameToTypingLocation.set(packageName, newTyping);
                    }
                }
            }
            if (this.log.isEnabled()) {
                this.log.writeLine(`Finished processing cache location '${cacheLocation}'`);
            }
            this.knownCachesSet.set(cacheLocation, true);
        }

        private filterTypings(typingsToInstall: ReadonlyArray<string>): ReadonlyArray<string> {
            return typingsToInstall.filter(typing => {
                if (this.missingTypingsSet.get(typing)) {
                    if (this.log.isEnabled()) this.log.writeLine(`'${typing}' is in missingTypingsSet - skipping...`);
                    return false;
                }
                const validationResult = JsTyping.validatePackageName(typing);
                if (validationResult !== JsTyping.PackageNameValidationResult.Ok) {
                    // add typing name to missing set so we won't process it again
                    this.missingTypingsSet.set(typing, true);
                    if (this.log.isEnabled()) this.log.writeLine(JsTyping.renderPackageNameValidationFailure(validationResult, typing));
                    return false;
                }
                if (!this.typesRegistry.has(typing)) {
                    if (this.log.isEnabled()) this.log.writeLine(`Entry for package '${typing}' does not exist in local types registry - skipping...`);
                    return false;
                }
                if (this.packageNameToTypingLocation.get(typing) && JsTyping.isTypingUpToDate(this.packageNameToTypingLocation.get(typing)!, this.typesRegistry.get(typing)!)) {
                    if (this.log.isEnabled()) this.log.writeLine(`'${typing}' already has an up-to-date typing - skipping...`);
                    return false;
                }
                return true;
            });
        }

        protected ensurePackageDirectoryExists(directory: string) {
            const npmConfigPath = combinePaths(directory, "package.json");
            if (this.log.isEnabled()) {
                this.log.writeLine(`Npm config file: ${npmConfigPath}`);
            }
            if (!this.installTypingHost.fileExists(npmConfigPath)) {
                if (this.log.isEnabled()) {
                    this.log.writeLine(`Npm config file: '${npmConfigPath}' is missing, creating new one...`);
                }
                this.ensureDirectoryExists(directory, this.installTypingHost);
                this.installTypingHost.writeFile(npmConfigPath, '{ "private": true }');
            }
        }

        private installTypings(req: DiscoverTypings, cachePath: string, currentlyCachedTypings: string[], typingsToInstall: string[]) {
            if (this.log.isEnabled()) {
                this.log.writeLine(`Installing typings ${JSON.stringify(typingsToInstall)}`);
            }
            const filteredTypings = this.filterTypings(typingsToInstall);
            if (filteredTypings.length === 0) {
                if (this.log.isEnabled()) {
                    this.log.writeLine(`All typings are known to be missing or invalid - no need to install more typings`);
                }
                this.sendResponse(this.createSetTypings(req, currentlyCachedTypings));
                return;
            }

            this.ensurePackageDirectoryExists(cachePath);

            const requestId = this.installRunCount;
            this.installRunCount++;

            // send progress event
            this.sendResponse(<BeginInstallTypes>{
                kind: EventBeginInstallTypes,
                eventId: requestId,
                typingsInstallerVersion: ts.version, // tslint:disable-line no-unnecessary-qualifier (qualified explicitly to prevent occasional shadowing)
                projectName: req.projectName
            });

            const scopedTypings = filteredTypings.map(typingsName);
            this.installTypingsAsync(requestId, scopedTypings, cachePath, ok => {
                try {
                    if (!ok) {
                        if (this.log.isEnabled()) {
                            this.log.writeLine(`install request failed, marking packages as missing to prevent repeated requests: ${JSON.stringify(filteredTypings)}`);
                        }
                        for (const typing of filteredTypings) {
                            this.missingTypingsSet.set(typing, true);
                        }
                        return;
                    }

                    // TODO: watch project directory
                    if (this.log.isEnabled()) {
                        this.log.writeLine(`Installed typings ${JSON.stringify(scopedTypings)}`);
                    }
                    const installedTypingFiles: string[] = [];
                    for (const packageName of filteredTypings) {
                        const typingFile = typingToFileName(cachePath, packageName, this.installTypingHost, this.log);
                        if (!typingFile) {
                            this.missingTypingsSet.set(packageName, true);
                            continue;
                        }

                        // packageName is guaranteed to exist in typesRegistry by filterTypings
                        const distTags = this.typesRegistry.get(packageName)!;
                        const newVersion = Semver.parse(distTags[`ts${versionMajorMinor}`] || distTags[latestDistTag]);
                        const newTyping: JsTyping.CachedTyping = { typingLocation: typingFile, version: newVersion };
                        this.packageNameToTypingLocation.set(packageName, newTyping);
                        installedTypingFiles.push(typingFile);
                    }
                    if (this.log.isEnabled()) {
                        this.log.writeLine(`Installed typing files ${JSON.stringify(installedTypingFiles)}`);
                    }

                    this.sendResponse(this.createSetTypings(req, currentlyCachedTypings.concat(installedTypingFiles)));
                }
                finally {
                    const response: EndInstallTypes = {
                        kind: EventEndInstallTypes,
                        eventId: requestId,
                        projectName: req.projectName,
                        packagesToInstall: scopedTypings,
                        installSuccess: ok,
                        typingsInstallerVersion: ts.version // tslint:disable-line no-unnecessary-qualifier (qualified explicitly to prevent occasional shadowing)
                    };
                    this.sendResponse(response);
                }
            });
        }

        private ensureDirectoryExists(directory: string, host: InstallTypingHost): void {
            const directoryName = getDirectoryPath(directory);
            if (!host.directoryExists(directoryName)) {
                this.ensureDirectoryExists(directoryName, host);
            }
            if (!host.directoryExists(directory)) {
                host.createDirectory(directory);
            }
        }

        private watchFiles(projectName: string, files: string[], projectRootPath: Path) {
            if (!files.length) {
                // shut down existing watchers
                this.closeWatchers(projectName);
                return;
            }

            let watchers = this.projectWatchers.get(projectName)!;
            const toRemove = createMap<FileWatcher>();
            if (!watchers) {
                watchers = createMap();
                this.projectWatchers.set(projectName, watchers);
            }
            else {
                copyEntries(watchers, toRemove);
            }

            // handler should be invoked once for the entire set of files since it will trigger full rediscovery of typings
            watchers.isInvoked = false;

            const isLoggingEnabled = this.log.isEnabled();
            const createProjectWatcher = (path: string, createWatch: (path: string) => FileWatcher) => {
                toRemove.delete(path);
                if (watchers.has(path)) {
                    return;
                }

                watchers.set(path, createWatch(path));
            };
            const createProjectFileWatcher = (file: string): FileWatcher => {
                if (isLoggingEnabled) {
                    this.log.writeLine(`FileWatcher:: Added:: WatchInfo: ${file}`);
                }
                const watcher = this.installTypingHost.watchFile!(file, (f, eventKind) => { // TODO: GH#18217
                    if (isLoggingEnabled) {
                        this.log.writeLine(`FileWatcher:: Triggered with ${f} eventKind: ${FileWatcherEventKind[eventKind]}:: WatchInfo: ${file}:: handler is already invoked '${watchers.isInvoked}'`);
                    }
                    if (!watchers.isInvoked) {
                        watchers.isInvoked = true;
                        this.sendResponse({ projectName, kind: ActionInvalidate });
                    }
                }, /*pollingInterval*/ 2000);

                return isLoggingEnabled ? {
                    close: () => {
                        this.log.writeLine(`FileWatcher:: Closed:: WatchInfo: ${file}`);
                        watcher.close();
                    }
                } : watcher;
            };
            const createProjectDirectoryWatcher = (dir: string): FileWatcher => {
                if (isLoggingEnabled) {
                    this.log.writeLine(`DirectoryWatcher:: Added:: WatchInfo: ${dir} recursive`);
                }
                const watcher = this.installTypingHost.watchDirectory!(dir, f => { // TODO: GH#18217
                    if (isLoggingEnabled) {
                        this.log.writeLine(`DirectoryWatcher:: Triggered with ${f} :: WatchInfo: ${dir} recursive :: handler is already invoked '${watchers.isInvoked}'`);
                    }
                    if (watchers.isInvoked) {
                        return;
                    }
                    f = this.toCanonicalFileName(f);
                    if (f !== this.globalCacheCanonicalPackageJsonPath && isPackageOrBowerJson(f)) {
                        watchers.isInvoked = true;
                        this.sendResponse({ projectName, kind: ActionInvalidate });
                    }
                }, /*recursive*/ true);

                return isLoggingEnabled ? {
                    close: () => {
                        this.log.writeLine(`DirectoryWatcher:: Closed:: WatchInfo: ${dir} recursive`);
                        watcher.close();
                    }
                } : watcher;
            };

            // Create watches from list of files
            for (const file of files) {
                const filePath = this.toCanonicalFileName(file);
                if (isPackageOrBowerJson(filePath)) {
                    // package.json or bower.json exists, watch the file to detect changes and update typings
                    createProjectWatcher(filePath, createProjectFileWatcher);
                    continue;
                }

                // path in projectRoot, watch project root
                if (containsPath(projectRootPath, filePath, projectRootPath, !this.installTypingHost.useCaseSensitiveFileNames)) {
                    createProjectWatcher(projectRootPath, createProjectDirectoryWatcher);
                    continue;
                }

                // path in global cache, watch global cache
                if (containsPath(this.globalCachePath, filePath, projectRootPath, !this.installTypingHost.useCaseSensitiveFileNames)) {
                    createProjectWatcher(this.globalCachePath, createProjectDirectoryWatcher);
                    continue;
                }

                // Get path without node_modules and bower_components
                createProjectWatcher(getDirectoryExcludingNodeModulesOrBowerComponents(getDirectoryPath(filePath)), createProjectDirectoryWatcher);
            }

            // Remove unused watches
            toRemove.forEach((watch, path) => {
                watch.close();
                watchers.delete(path);
            });
        }

        private createSetTypings(request: DiscoverTypings, typings: string[]): SetTypings {
            return {
                projectName: request.projectName,
                typeAcquisition: request.typeAcquisition,
                compilerOptions: request.compilerOptions,
                typings,
                unresolvedImports: request.unresolvedImports,
                kind: ActionSet
            };
        }

        private installTypingsAsync(requestId: number, packageNames: string[], cwd: string, onRequestCompleted: RequestCompletedAction): void {
            this.pendingRunRequests.unshift({ requestId, packageNames, cwd, onRequestCompleted });
            this.executeWithThrottling();
        }

        private executeWithThrottling() {
            while (this.inFlightRequestCount < this.throttleLimit && this.pendingRunRequests.length) {
                this.inFlightRequestCount++;
                const request = this.pendingRunRequests.pop()!;
                this.installWorker(request.requestId, request.packageNames, request.cwd, ok => {
                    this.inFlightRequestCount--;
                    request.onRequestCompleted(ok);
                    this.executeWithThrottling();
                });
            }
        }

        protected abstract installWorker(requestId: number, packageNames: string[], cwd: string, onRequestCompleted: RequestCompletedAction): void;
        protected abstract sendResponse(response: SetTypings | InvalidateCachedTypings | BeginInstallTypes | EndInstallTypes): void;
    }

    /* @internal */
    export function typingsName(packageName: string): string {
        return `@types/${packageName}@ts${versionMajorMinor}`;
    }

    const latestDistTag = "latest";
}
