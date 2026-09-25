// `mountEmbeddableHost` is only a fix while the embeddable mount effect really
// dispatches through it: unconditionally, and cancelling per invocation. The
// effect lives in a .tsx that imports the types-only `obsidian` package, so it
// cannot be loaded here; these checks read its syntax instead. The wait for the
// factory lives inside the helper, so a guard in front of the dispatch, or a
// cancellation flag shared between invocations, would mount the whole-file
// workspace leaf. Node identity is asserted with assert.ok: assert.equal
// serializes both nodes on failure, and a parent-linked AST is large enough to
// exhaust the heap.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(
  new URL("../src/view/components/CustomEmbeddable.tsx", import.meta.url),
  "utf8",
);
const file = ts.createSourceFile(
  "CustomEmbeddable.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

const log = (message) => process.stdout.write(`${message}\n`);

const collect = (match) => {
  const found = [];
  const visit = (node) => {
    if (match(node)) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
};

const enclosingFunction = (node) => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) {
      return parent;
    }
  }
  return undefined;
};

const enclosingStatement = (node) => {
  let current = node;
  while (current.parent && !ts.isStatement(current)) {
    current = current.parent;
  }
  return current;
};

assert.equal(
  collect(
    (node) =>
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier.text === "src/utils/embeddableMountPlan",
  ).length,
  1,
  "the mount effect must import the mount-plan dispatch",
);

const dispatches = collect(
  (node) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "mountEmbeddableHost",
);
assert.equal(
  dispatches.length,
  1,
  "the mount effect must call mountEmbeddableHost exactly once",
);
const [dispatch] = dispatches;
const effect = enclosingFunction(dispatch);
assert.ok(effect, "the dispatch must be called from the mount effect");

const [options] = dispatch.arguments;
assert.ok(
  options && ts.isObjectLiteralExpression(options),
  "the dispatch must be passed its mount options",
);
const option = (name) =>
  options.properties.find(
    (property) =>
      property.name &&
      ts.isIdentifier(property.name) &&
      property.name.text === name,
  );

for (const name of [
  "subpath",
  "fileExtension",
  "getHost",
  "isCancelled",
  "createCanvasNode",
  "createWorkspaceLeaf",
]) {
  assert.ok(option(name), `the dispatch must pass ${name}`);
}

//The helper decides between the hosts from these three inputs. A readiness
//test folded into any of them (a subpath or extension blanked while the
//factory starts, a getHost that hides an unready factory) keeps the dispatch
//unconditional in form and still routes a slow start to the whole-file leaf.
assert.ok(
  ts.isShorthandPropertyAssignment(option("subpath")),
  "the dispatch must forward the link's subpath as it is",
);
assert.equal(
  option("fileExtension").initializer?.getText(file),
  "file.extension",
  "the dispatch must forward the file's own extension",
);
const getHost = option("getHost");
assert.ok(
  ts.isPropertyAssignment(getHost) &&
    ts.isArrowFunction(getHost.initializer) &&
    getHost.initializer.body.getText(file) === "view.canvasNodeFactory",
  "getHost must return the view's factory whatever its state",
);

const statement = enclosingStatement(dispatch);
assert.ok(
  ts.isExpressionStatement(statement),
  "the dispatch must be a statement of its own",
);
assert.ok(
  statement.parent === effect.body,
  "the dispatch must sit in the effect's body, not in a conditional branch",
);
assert.ok(
  (ts.isVoidExpression(statement.expression)
    ? statement.expression.expression
    : statement.expression) === dispatch,
  "the dispatch must be the whole expression, not an operand of a guard",
);

assert.equal(
  collect(
    (node) =>
      ts.isIdentifier(node) &&
      node.text === "canvasNodeFactory" &&
      enclosingFunction(node) === effect,
  ).length,
  0,
  "the effect's own body must not consult the factory: readiness is the helper's to await",
);

for (const name of ["createNode", "mountWorkspaceLeaf"]) {
  assert.equal(
    collect(
      (node) =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === name &&
        enclosingFunction(node) === effect,
    ).length,
    0,
    `the effect must mount only through the dispatch: a direct ${name}() call beside it mounts a second host`,
  );
}

const isCancelled = option("isCancelled");
assert.ok(
  ts.isPropertyAssignment(isCancelled) &&
    ts.isArrowFunction(isCancelled.initializer),
  "the cancellation signal must be a function the helper can re-read",
);
let firstOperand = isCancelled.initializer.body;
while (
  ts.isBinaryExpression(firstOperand) &&
  firstOperand.operatorToken.kind === ts.SyntaxKind.BarBarToken
) {
  firstOperand = firstOperand.left;
}
assert.ok(
  ts.isIdentifier(firstOperand) && firstOperand.text === "effectCancelled",
  "the cancellation signal must consult this invocation's own flag first, not only the refs a replacement mount repopulates",
);

const declarations = collect(
  (node) =>
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "effectCancelled",
);
assert.equal(
  declarations.length,
  1,
  "the cancellation flag must be declared exactly once",
);
assert.ok(
  enclosingFunction(declarations[0]) === effect,
  "the cancellation flag must be declared in the mount effect's own body, not shared by every invocation",
);

const cleanup = effect.body.statements.find(ts.isReturnStatement);
assert.ok(
  cleanup && ts.isArrowFunction(cleanup.expression),
  "the mount effect must return a cleanup",
);
const [firstCleanupStatement] = cleanup.expression.body.statements;
assert.equal(
  firstCleanupStatement.getText(file),
  "effectCancelled = true;",
  "the cleanup must supersede a pending mount before any of its early returns",
);

assert.equal(
  collect(
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "mountWorkspaceLeaf" &&
      enclosingFunction(node) === effect,
  ).length,
  1,
  "the workspace leaf path must remain a callable the dispatch can fall back to",
);

log("embeddable mount call site checks passed");
