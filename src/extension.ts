import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as xml2js from 'xml2js';
import * as event from 'events';
import * as fs from 'fs';
import * as node_path from 'path';

import { File } from '../lib/node-utility/File';
import { ResourceManager } from './ResourceManager';
import { FileWatcher } from '../lib/node-utility/FileWatcher';
import { Time } from '../lib/node-utility/Time';

export function activate(context: vscode.ExtensionContext) {

	console.log('---- keil-assistant actived ----');

	// init resource
	ResourceManager.getInstance(context);

	const prjExplorer = new ProjectExplorer(context);
	const subscriber = context.subscriptions;

	subscriber.push(vscode.commands.registerCommand('explorer.open', async () => {

		const uri = await vscode.window.showOpenDialog({
			openLabel: 'Open a keil project',
			canSelectFolders: false,
			canSelectMany: false,
			filters: {
				'C51': ['uvproj'],
				'Keil MDK': ['uvprojx']
			}
		});

		if (uri && uri.length > 0) {
			await prjExplorer.openProject(uri[0].fsPath);
		}
	}));

	subscriber.push(vscode.commands.registerCommand('project.close', (item: IView) => prjExplorer.closeProject(item.prjID)));

	subscriber.push(vscode.commands.registerCommand('project.build', (item: IView) => prjExplorer.getProject(item.prjID)?.build()));

	subscriber.push(vscode.commands.registerCommand('project.rebuild', (item: IView) => prjExplorer.getProject(item.prjID)?.rebuild()));

	subscriber.push(vscode.commands.registerCommand('project.download', (item: IView) => prjExplorer.getProject(item.prjID)?.download()));

	subscriber.push(vscode.commands.registerCommand('item.copyValue', (item: IView) => vscode.env.clipboard.writeText(item.tooltip || '')));

	prjExplorer.loadWorkspace();
}

export function deactivate() {
	console.log('---- keil-assistant closed ----');
}

process.on('uncaughtException', (err) => {
	console.error(err);
});

//===============================================

function getMD5(data: string): string {
	const md5 = crypto.createHash('md5');
	md5.update(data);
	return md5.digest('hex');
}

//===============================

interface IView {

	label: string;

	prjID: string;

	icons?: { light: string, dark: string };

	tooltip?: string;

	contextVal?: string;

	getChildViews(): IView[] | undefined;
}

//===============================================

class Source implements IView {

	label: string;
	prjID: string;
	icons?: { light: string; dark: string; } | undefined;
	tooltip?: string | undefined;
	contextVal?: string | undefined;

	//---
	readonly file: File;

	constructor(pID: string, f: File, _enable: boolean = true) {
		this.prjID = pID;
		this.file = f;
		this.label = this.file.name;
		this.tooltip = f.path;
		this.contextVal = Source.name;
		const iName = _enable ? this.getIconBySuffix(f.suffix.toLowerCase()) : 'FileExclude_16x';
		this.icons = {
			dark: iName,
			light: iName
		};
	}

	private getIconBySuffix(suffix: string): string {
		switch (suffix) {
			case '.c':
				return 'CFile_16x';
			case '.h':
			case '.hpp':
			case '.hxx':
			case '.inc':
				return 'CPPHeaderFile_16x';
			case '.cpp':
			case '.c++':
			case '.cxx':
			case '.cc':
				return 'CPP_16x';
			case '.s':
			case '.a51':
			case '.asm':
				return 'AssemblerSourceFile_16x';
			case '.lib':
				return 'Library_16x';
			default:
				return 'Text_16x';
		}
	}

	getChildViews(): IView[] | undefined {
		return undefined;
	}
}

class FileGroup implements IView {

	label: string;
	prjID: string;
	tooltip?: string | undefined;
	contextVal?: string | undefined;
	icons?: { light: string; dark: string; } = {
		light: 'CheckboxGroup_16x',
		dark: 'CheckboxGroup_16x'
	};

	//----
	sources: Source[];

	constructor(pID: string, gName: string) {
		this.label = gName;
		this.prjID = pID;
		this.sources = [];
		this.tooltip = gName;
		this.contextVal = FileGroup.name;
	}

	getChildViews(): IView[] | undefined {
		return this.sources;
	}
}

abstract class Project implements IView {

	prjID: string;
	label: string;
	tooltip?: string | undefined;
	contextVal?: string | undefined;
	icons?: { light: string; dark: string; } = {
		light: 'Class_16x',
		dark: 'Class_16x'
	};

	//-------------

	static readonly cppConfigName = 'keil';

	protected _event: event.EventEmitter;
	protected uvprjFile: File;
	protected vscodeDir: File;
	protected watcher: FileWatcher;

	protected fGroups: FileGroup[];
	protected includes: Set<string>;
	protected defines: Set<string>;

	protected logger: Console;

	constructor(_uvprjFile: File) {
		this._event = new event.EventEmitter();
		this.vscodeDir = new File(_uvprjFile.dir + File.sep + '.vscode');
		this.vscodeDir.CreateDir();
		this.logger = new console.Console(fs.createWriteStream(
			this.vscodeDir.path + File.sep + 'keil-assistant.log', { flags: 'a+' }));
		this.uvprjFile = _uvprjFile;
		this.watcher = new FileWatcher(this.uvprjFile);
		this.prjID = getMD5(_uvprjFile.path);
		this.label = _uvprjFile.noSuffixName;
		this.tooltip = _uvprjFile.path;
		this.contextVal = Project.name;
		this.includes = new Set();
		this.defines = new Set();
		this.fGroups = [];
		this.logger.log('Log at : ' + Time.GetInstance().GetTimeStamp() + '\r\n');
	}

	on(event: 'dataChanged', listener: () => void): void;
	on(event: any, listener: () => void): void {
		this._event.on(event, listener);
	}

	static async getInstance(uvprjFile: File): Promise<Project> {
		let prj: Project;
		if (uvprjFile.suffix.toLowerCase() === '.uvproj') {
			prj = new C51project(uvprjFile);
		} else {
			prj = new ArmProject(uvprjFile);
		}
		await prj.init();
		return prj;
	}

	private getDefCppProperties(): any {
		return {
			configurations: [
				{
					name: Project.cppConfigName,
					includePath: undefined,
					defines: undefined,
					intelliSenseMode: '${default}'
				}
			],
			version: 4
		};
	}

	private updateCppProperties() {

		const proFile = new File(this.vscodeDir.path + File.sep + 'c_cpp_properties.json');
		let obj: any;

		if (proFile.IsFile()) {
			try {
				obj = JSON.parse(proFile.Read());
			} catch (error) {
				console.warn(error);
				obj = this.getDefCppProperties();
			}
		} else {
			obj = this.getDefCppProperties();
		}

		const configList: any[] = obj['configurations'];
		const index = configList.findIndex((conf) => { return conf.name === Project.cppConfigName; });

		if (index === -1) {
			configList.push({
				name: Project.cppConfigName,
				includePath: Array.from(this.includes),
				defines: Array.from(this.defines),
				intelliSenseMode: '${default}'
			});
		} else {
			configList[index]['includePath'] = Array.from(this.includes);
			configList[index]['defines'] = Array.from(this.defines);
		}

		proFile.Write(JSON.stringify(obj, undefined, 4));
	}

	async reload(): Promise<void> {

		const parser = new xml2js.Parser({ explicitArray: false });
		const doc = await parser.parseStringPromise({ toString: () => { return this.uvprjFile.Read(); } });

		const incListStr: string = this.getIncString(doc['Project']);
		const defineListStr: string = this.getDefineString(doc['Project']);
		const _groups: any = this.getGroups(doc['Project']);
		const sysIncludes = this.getSystemIncludes(doc['Project']);

		// set includes
		this.includes.clear();

		let incList = incListStr.split(';');
		if (sysIncludes) {
			incList = incList.concat(sysIncludes);
		}

		incList.forEach((path) => {
			if (path.trim() !== '') {
				this.includes.add(this.toAbsolutePath(path));
			}
		});

		// set defines
		this.defines.clear();
		defineListStr.split(/,|\s+/).forEach((define) => {
			if (define.trim() !== '') {
				this.defines.add(define);
			}
		});

		// set file groups
		this.fGroups = [];

		let groups: any[];
		if (Array.isArray(_groups)) {
			groups = _groups;
		} else {
			groups = [_groups];
		}

		for (const group of groups) {

			if (group['Files'] !== undefined) {
				const nGrp = new FileGroup(this.prjID, group['GroupName']);

				let files: any[];
				if (Array.isArray(group['Files']['File'])) {
					files = group['Files']['File'];
				}
				else if (group['Files']['File'] !== undefined) {
					files = [group['Files']['File']];
				} else {
					files = [];
				}

				for (const file of files) {
					const f = new File(this.toAbsolutePath(file['FilePath']));
					// check file is enable
					let enable = true;
					if (file['FileOption']) {
						const fOption = file['FileOption']['CommonProperty'];
						if (fOption && fOption['IncludeInBuild'] === '0') {
							enable = false;
						}
					}
					const nFile = new Source(this.prjID, f, enable);
					this.includes.add(f.dir);
					nGrp.sources.push(nFile);
				}
				this.fGroups.push(nGrp);
			}
		}

		this.updateCppProperties();

		this._event.emit('dataChanged');
	}

	async init() {
		try {
			await this.reload();
			this.watcher.Watch();
			this.watcher.OnChanged = () => {
				try {
					this.reload();
				} catch (error) {
					this.logger.warn(error);
				}
			};
		} catch (error) {
			this.logger.warn(error);
		}
	}

	private runTask(name: string, commands: string[]) {

		const task = new vscode.Task({ type: 'keil-task' }, vscode.TaskScope.Global, name, 'shell');
		const resManager = ResourceManager.getInstance();
		let args: string[] = [];
		const uv4Log = new File(this.vscodeDir.path + File.sep + 'uv4.log');

		args.push('-o');
		args.push(uv4Log.path);

		args = args.concat(commands);

		task.execution = new vscode.ShellExecution({
			quoting: vscode.ShellQuoting.Strong,
			value: resManager.getBuilderExe()
		}, args.map((arg) => {
			return <vscode.ShellQuotedString>{
				value: arg,
				quoting: vscode.ShellQuoting.Strong
			};
		}));
		task.isBackground = false;
		task.problemMatchers = this.getProblemMatcher();
		task.presentationOptions = {
			echo: false,
			focus: false,
			clear: true
		};

		vscode.tasks.executeTask(task);
	}

	build() {
		this.runTask('build', this.getBuildCommand());
	}

	rebuild() {
		this.runTask('rebuild', this.getRebuildCommand());
	}

	download() {
		this.runTask('download', this.getDownloadCommand());
	}

	close() {
		this.watcher.Close();
		this.logger.log('---- project closed ----\r\n');
	}

	toRelativePath(_path: string): string | undefined {
		let path = _path.replace(/\//g, '\\');
		if (path.startsWith(this.uvprjFile.dir)) {
			return path.replace(this.uvprjFile.dir, '.');
		}
		return undefined;
	}

	toAbsolutePath(rePath: string): string {
		let path = rePath.replace(/\//g, '\\');
		if (path.startsWith('.') || !/^[a-z]:/i.test(path)) {
			path = this.uvprjFile.dir + File.sep + path;
		}
		return path;
	}

	getChildViews(): IView[] | undefined {
		return this.fGroups;
	}

	protected abstract getIncString(keilDoc: any): string;
	protected abstract getDefineString(keilDoc: any): string;
	protected abstract getGroups(keilDoc: any): any[];

	protected abstract getSystemIncludes(keilDoc: any): string[] | undefined;

	protected abstract getProblemMatcher(): string[];
	protected abstract getBuildCommand(): string[];
	protected abstract getRebuildCommand(): string[];
	protected abstract getDownloadCommand(): string[];
}

//===============================================

class C51project extends Project {

	protected getSystemIncludes(keilDoc: any): string[] | undefined {
		const exeFile = new File(ResourceManager.getInstance().getC51UV4Path());
		if (exeFile.IsFile()) {
			return [
				node_path.dirname(exeFile.dir) + File.sep + 'C51' + File.sep + 'INC'
			];
		}
		return undefined;
	}

	protected getIncString(keilDoc: any): string {
		const target51 = keilDoc['Targets']['Target']['TargetOption']['Target51']['C51'];
		return target51['VariousControls']['IncludePath'];
	}

	protected getDefineString(keilDoc: any): string {
		const target51 = keilDoc['Targets']['Target']['TargetOption']['Target51']['C51'];
		return target51['VariousControls']['Define'];
	}

	protected getGroups(keilDoc: any): any[] {
		return keilDoc['Targets']['Target']['Groups']['Group'] || [];
	}

	protected getProblemMatcher(): string[] {
		return ['$c51'];
	}

	protected getBuildCommand(): string[] {
		const cmds: string[] = [];
		cmds.push('-e');
		cmds.push(ResourceManager.getInstance().getC51UV4Path());

		cmds.push('-u');
		cmds.push(this.uvprjFile.path);

		cmds.push('-c');
		cmds.push('${uv4Path} -b ${prjPath} -j0');
		return cmds;
	}

	protected getRebuildCommand(): string[] {
		const cmds: string[] = [];
		cmds.push('-e');
		cmds.push(ResourceManager.getInstance().getC51UV4Path());

		cmds.push('-u');
		cmds.push(this.uvprjFile.path);

		cmds.push('-c');
		cmds.push('${uv4Path} -r ${prjPath} -j0 -z');
		return cmds;
	}

	protected getDownloadCommand(): string[] {
		const cmds: string[] = [];
		cmds.push('-e');
		cmds.push(ResourceManager.getInstance().getC51UV4Path());

		cmds.push('-u');
		cmds.push(this.uvprjFile.path);

		cmds.push('-c');
		cmds.push('${uv4Path} -f ${prjPath} -j0');
		return cmds;
	}
}

class ArmProject extends Project {

	protected getSystemIncludes(keilDoc: any): string[] | undefined {
		const exeFile = new File(ResourceManager.getInstance().getArmUV4Path());
		if (exeFile.IsFile()) {
			let toolName = keilDoc['Targets']['Target']['uAC6'] === '1' ? 'ARMCLANG' : 'ARMCC';
			return [
				node_path.dirname(exeFile.dir) + File.sep + 'ARM' + File.sep + toolName + File.sep + 'include'
			];
		}
		return undefined;
	}

	protected getIncString(keilDoc: any): string {
		const dat = keilDoc['Targets']['Target']['TargetOption']['TargetArmAds']['Cads'];
		return dat['VariousControls']['IncludePath'];
	}

	protected getDefineString(keilDoc: any): string {
		const dat = keilDoc['Targets']['Target']['TargetOption']['TargetArmAds']['Cads'];
		return dat['VariousControls']['Define'];
	}

	protected getGroups(keilDoc: any): any[] {
		return keilDoc['Targets']['Target']['Groups']['Group'] || [];
	}

	protected getProblemMatcher(): string[] {
		return ['$armcc'];
	}

	protected getBuildCommand(): string[] {
		const cmds: string[] = [];
		cmds.push('-e');
		cmds.push(ResourceManager.getInstance().getArmUV4Path());

		cmds.push('-u');
		cmds.push(this.uvprjFile.path);

		cmds.push('-c');
		cmds.push('${uv4Path} -b ${prjPath} -j0');
		return cmds;
	}

	protected getRebuildCommand(): string[] {
		const cmds: string[] = [];
		cmds.push('-e');
		cmds.push(ResourceManager.getInstance().getArmUV4Path());

		cmds.push('-u');
		cmds.push(this.uvprjFile.path);

		cmds.push('-c');
		cmds.push('${uv4Path} -r ${prjPath} -j0 -z');
		return cmds;
	}

	protected getDownloadCommand(): string[] {
		const cmds: string[] = [];
		cmds.push('-e');
		cmds.push(ResourceManager.getInstance().getArmUV4Path());

		cmds.push('-u');
		cmds.push(this.uvprjFile.path);

		cmds.push('-c');
		cmds.push('${uv4Path} -f ${prjPath} -j0');
		return cmds;
	}
}

//================================================

class ProjectExplorer implements vscode.TreeDataProvider<IView> {

	private ItemClickCommand: string = 'Item.Click';

	onDidChangeTreeData: vscode.Event<IView>;
	private viewEvent: vscode.EventEmitter<IView>;

	private prjList: Map<string, Project>;

	constructor(context: vscode.ExtensionContext) {
		this.prjList = new Map();
		this.viewEvent = new vscode.EventEmitter();
		this.onDidChangeTreeData = this.viewEvent.event;
		context.subscriptions.push(vscode.window.registerTreeDataProvider('project', this));
		context.subscriptions.push(vscode.commands.registerCommand(this.ItemClickCommand, (item) => this.onItemClick(item)));
	}

	async loadWorkspace() {
		if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
			const workspace = new File(vscode.workspace.workspaceFolders[0].uri.fsPath);
			const uvList = workspace.GetList([/\.uvproj[x]?$/i], File.EMPTY_FILTER);
			for (const uvFile of uvList) {
				await this.openProject(uvFile.path);
			}
		}
	}

	async openProject(path: string) {
		const nPrj = await Project.getInstance(new File(path));
		if (!this.prjList.has(nPrj.prjID)) {
			nPrj.init();
			nPrj.on('dataChanged', () => this.updateView());
			this.prjList.set(nPrj.prjID, nPrj);
			this.updateView();
		}
	}

	async closeProject(pID: string) {
		const prj = this.prjList.get(pID);
		if (prj) {
			prj.close();
			this.prjList.delete(pID);
			this.updateView();
		}
	}

	getProject(pID: string): Project | undefined {
		return this.prjList.get(pID);
	}

	updateView() {
		this.viewEvent.fire();
	}

	//----------------------------------

	private async onItemClick(item: IView) {
		switch (item.contextVal) {
			case Source.name:
				const source = <Source>item;
				const uri = vscode.Uri.parse(source.file.ToUri());
				vscode.window.showTextDocument(uri);
				break;
			default:
				break;
		}
	}

	getTreeItem(element: IView): vscode.TreeItem | Thenable<vscode.TreeItem> {
		const res = new vscode.TreeItem(element.label);
		res.contextValue = element.contextVal;
		res.tooltip = element.tooltip;
		res.collapsibleState = element.getChildViews() === undefined ?
			vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed;
		res.command = {
			title: element.label,
			command: this.ItemClickCommand,
			arguments: [element]
		};
		if (element.icons) {
			res.iconPath = {
				light: ResourceManager.getInstance().getIconByName(element.icons.light),
				dark: ResourceManager.getInstance().getIconByName(element.icons.dark)
			};
		}
		return res;
	}

	getChildren(element?: IView | undefined): vscode.ProviderResult<IView[]> {
		if (element === undefined) {
			return Array.from(this.prjList.values());
		} else {
			return element.getChildViews();
		}
	}
}