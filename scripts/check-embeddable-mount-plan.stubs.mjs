/**
 * Runtime stand-ins for the two modules `CanvasNodeFactory` imports but does not
 * exercise while initializing or being destroyed.
 *
 * `obsidian` ships types only (`"main": ""`), so it cannot be loaded outside the
 * app; `obsidianUtils` pulls in the whole plugin. Both are aliased to this one
 * module, which exports the union of the members the factory names -- enough for
 * its lifecycle to run, and nothing more, so a stub can never stand in for the
 * behaviour under test.
 */

/** Only ever constructed and then assigned two getters by the factory. */
export class WorkspaceSplit {}
export class WorkspaceLeaf {}
export class View {}
export class TFile {}
export class Editor {}

/** The factory hands the result to `rootSplit.getContainer`; nothing reads it. */
export const getContainerForDocument = () => ({});
export const isObsidianThemeDark = () => false;
