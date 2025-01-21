/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import prettyFormat from 'pretty-format';
import {CompilerError, SourceLocation} from '..';
import {
  BlockId,
  DeclarationId,
  DoWhileTerminal,
  ForInTerminal,
  ForOfTerminal,
  ForTerminal,
  GotoVariant,
  HIRFunction,
  Identifier,
  IdentifierId,
  IfTerminal,
  Instruction,
  LabelTerminal,
  Place,
  ReactiveScope,
  ScopeId,
  SwitchTerminal,
  WhileTerminal,
} from '../HIR';
import {printIdentifier, printInstruction} from '../HIR/PrintHIR';
import {
  eachInstructionValueLValue,
  eachInstructionValueOperand,
  terminalFallthrough,
} from '../HIR/visitors';
import {assertExhaustive, getOrInsertWith} from '../Utils/utils';
import {
  GotoNode,
  ControlNode,
  EntryNode,
  InstructionNode,
  LoadArgumentNode,
  LoadNode,
  makeReactiveId,
  NodeDependencies,
  NodeReference,
  populateReactiveGraphNodeOutputs,
  ReactiveGraph,
  ReactiveId,
  ReactiveNode,
  reversePostorderReactiveGraph,
  StoreNode,
  eachNodeDependency,
  FallthroughNode,
  printReactiveGraph,
  IfNode,
  PhiNode,
  ThrowNode,
  ReturnNode,
  LabelNode,
} from './ReactiveIR';

export function buildReactiveGraph(fn: HIRFunction): ReactiveGraph {
  const builder = new Builder();
  const context = new ControlContext(builder, {kind: 'Function'});
  const entryNode: EntryNode = {
    kind: 'Entry',
    id: builder.nextReactiveId,
    loc: fn.loc,
    outputs: [],
  };
  context.putNode(entryNode);
  for (const param of fn.params) {
    const place = param.kind === 'Identifier' ? param : param.place;
    const node: LoadArgumentNode = {
      kind: 'LoadArgument',
      id: builder.nextReactiveId,
      loc: place.loc,
      outputs: [],
      place: {...place},
      control: entryNode.id,
    };
    context.putNode(node);
    context.recordDeclarationWrite(place.identifier.declarationId, node.id);
  }

  const exitNode = buildBlockScope(fn, context, fn.body.entry, entryNode.id);

  const graph = builder.build(fn, entryNode.id, exitNode);

  console.log();
  console.log(printReactiveGraph(graph));

  populateReactiveGraphNodeOutputs(graph);
  reversePostorderReactiveGraph(graph);
  return graph;
}

class Builder {
  #nextNodeId: number = 0;
  #environment: Map<IdentifierId, ReactiveId> = new Map();
  #nodes: Map<ReactiveId, ReactiveNode> = new Map();

  build(fn: HIRFunction, entry: ReactiveId, exit: ReactiveId): ReactiveGraph {
    const graph: ReactiveGraph = {
      async: fn.async,
      directives: fn.directives,
      env: fn.env,
      entry,
      exit,
      fnType: fn.fnType,
      generator: fn.generator,
      id: fn.id,
      loc: fn.loc,
      nextNodeId: this.#nextNodeId,
      nodes: this.#nodes,
      params: fn.params,
    };
    return graph;
  }

  get nextReactiveId(): ReactiveId {
    return makeReactiveId(this.#nextNodeId++);
  }

  putNode(node: ReactiveNode): void {
    this.#nodes.set(node.id, node);
  }

  storeTemporary(place: Place, node: ReactiveId): void {
    this.#environment.set(place.identifier.id, node);
  }

  lookupTemporary(identifier: Identifier, loc: SourceLocation): ReactiveId {
    const dep = this.#environment.get(identifier.id);
    CompilerError.invariant(dep != null, {
      reason: `No source node for identifier ${printIdentifier(identifier)}`,
      loc,
    });
    return dep;
  }
}

type Fallthrough =
  | {kind: 'Function'}
  | {kind: 'Label'; block: BlockId; fallthrough: ReactiveId}
  | {kind: 'If'; block: BlockId; fallthrough: ReactiveId};

class ControlContext {
  constructor(
    private builder: Builder,
    private fallthrough: Fallthrough,
    private declarations: Map<
      DeclarationId,
      {write: ReactiveId | null; read: ReactiveId | null}
    > = new Map(),
    private scopes: Map<ScopeId, ReactiveId> = new Map(),
    private nodes: Set<ReactiveId> = new Set(),
    private breakMapping: Map<BlockId, ReactiveId> = new Map(),
    private parent: ControlContext | null = null,
  ) {}

  fork(fallthrough: Fallthrough): ControlContext {
    return new ControlContext(
      this.builder,
      fallthrough,
      /*
       * We reset these maps so that the first reference of each declaration/scope within the branch
       * will depend on the branch's control. subsequent references can then refer to branch-local
       * instance
       */
      new Map(),
      new Map(),
      // Track not-yet-depended on nodes in this context so the terminal node can depend on them
      new Set(),
      this.breakMapping,
      this,
    );
  }

  forkValue(): ControlContext {
    return new ControlContext(
      this.builder,
      this.fallthrough,
      new Map(),
      new Map(),
      new Set(),
      this.breakMapping,
      this,
    );
  }

  putBreakMapping(block: BlockId, node: ReactiveId): void {
    this.breakMapping.set(block, node);
  }

  getBreakMapping(block: BlockId, loc: SourceLocation): ReactiveId {
    const node = this.breakMapping.get(block);
    if (node == null) {
      console.log(
        `No break mapping for bb${block}`,
        prettyFormat(this.breakMapping),
      );
    }
    CompilerError.invariant(node !== undefined, {
      reason: `Unset break mapping for bb${block}`,
      loc,
    });
    return node;
  }

  controlNode(control: ReactiveId, loc: SourceLocation): ReactiveId {
    const node: ControlNode = {
      kind: 'Control',
      id: this.nextReactiveId,
      loc,
      outputs: [],
      control,
    };
    this.putNode(node);
    return node.id;
  }

  putNode(node: ReactiveNode): void {
    for (const dep of eachNodeDependency(node)) {
      this.nodes.delete(dep);
    }
    this.nodes.add(node.id);
    this.builder.putNode(node);
  }

  /*
   * Returns the nodes added to this context which are not yet depended on
   * by other nodes
   */
  uncontolledNodes(): Array<ReactiveId> {
    return Array.from(this.nodes);
  }

  get nextReactiveId(): ReactiveId {
    return this.builder.nextReactiveId;
  }

  storeTemporary(place: Place, node: ReactiveId): void {
    this.builder.storeTemporary(place, node);
  }

  lookupTemporary(identifier: Identifier, loc: SourceLocation): ReactiveId {
    return this.builder.lookupTemporary(identifier, loc);
  }

  loadBreakTarget(target: BlockId, loc: SourceLocation): ReactiveId {
    if (
      (this.fallthrough.kind === 'If' || this.fallthrough.kind === 'Label') &&
      this.fallthrough.block === target
    ) {
      return this.fallthrough.fallthrough;
    }
    if (this.parent != null) {
      return this.parent.loadBreakTarget(target, loc);
    }
    CompilerError.invariant(false, {
      reason: `Cannot find break target for bb${target}`,
      loc,
    });
  }

  loadContinueTarget(target: BlockId, loc: SourceLocation): ReactiveId {
    CompilerError.invariant(false, {
      reason: `Cannot find continue target for bb${target}`,
      loc,
    });
  }

  // Scopes

  *eachScope(): Iterable<[ScopeId, ReactiveId]> {
    yield* this.scopes;
  }

  recordScopeMutation(scope: ScopeId, node: ReactiveId): void {
    this.scopes.set(scope, node);
  }

  loadScopeControl(scope: ScopeId): ReactiveId | null {
    return this.scopes.get(scope) ?? null;
  }

  // Declarations

  *eachDeclaration(): Iterable<
    [DeclarationId, {write: ReactiveId | null; read: ReactiveId | null}]
  > {
    yield* this.declarations;
  }

  // Loads the node that writes the value being read from
  loadDeclarationForRead(
    declarationId: DeclarationId,
    loc: SourceLocation,
  ): ReactiveId {
    const declaration = this.declarations.get(declarationId);
    if (declaration != null && declaration.write != null) {
      return declaration.write;
    }
    if (this.parent == null) {
      CompilerError.invariant(false, {
        reason: `Cannot find declaration #${declarationId}`,
        loc,
      });
    }
    return this.parent.loadDeclarationForRead(declarationId, loc);
  }

  /**
   * Determines the node that should be used as the *control* when reading,
   * which will be the last write in the current context, or null if there are
   * no writes in the current context
   */
  loadDeclarationControlForRead(
    declarationId: DeclarationId,
  ): ReactiveId | null {
    const declaration = this.declarations.get(declarationId);
    if (declaration == null || declaration.write == null) {
      return null;
    }
    return declaration.write;
  }

  /**
   * Determines the node that should be used as the control when writing,
   * which will be the last write *or read* in the current context, or null
   * if there are no reads/writes in the current context.
   */
  loadDeclarationControlForWrite(
    declarationId: DeclarationId,
    loc: SourceLocation,
  ): ReactiveId | null {
    const declaration = this.declarations.get(declarationId);
    if (declaration == null) {
      return null;
    }
    const source = declaration.read ?? declaration.write;
    CompilerError.invariant(source != null, {
      reason: `Expected declaration to have a write or read node`,
      loc,
    });
    return source;
  }

  recordDeclarationWrite(declarationId: DeclarationId, node: ReactiveId): void {
    const declaration = getOrInsertWith(
      this.declarations,
      declarationId,
      () => ({
        write: null,
        read: null,
      }),
    );
    declaration.write = node;
  }

  recordDeclarationRead(declarationId: DeclarationId, node: ReactiveId): void {
    const declaration = getOrInsertWith(
      this.declarations,
      declarationId,
      () => ({
        write: null,
        read: null,
      }),
    );
    declaration.read = node;
  }
}

function buildBlockScope(
  fn: HIRFunction,
  context: ControlContext,
  entry: BlockId,
  control: ReactiveId,
): ReactiveId {
  let block = fn.body.blocks.get(entry)!;
  let lastNode = control;
  while (true) {
    // iterate instructions of the block
    for (const instr of block.instructions) {
      const {lvalue, value} = instr;

      if (value.kind === 'LoadLocal') {
        // Find the node that defines the version of the value we are reading: the last write
        const source = context.loadDeclarationForRead(
          value.place.identifier.declarationId,
          value.place.loc,
        );
        /*
         * Determine the control, which is either the previous write in this context, or
         * the context's control
         */
        const instructionControl =
          context.loadDeclarationControlForRead(
            value.place.identifier.declarationId,
          ) ?? control;

        /*
         * TODO: we need to create a LoadLocal node so that we have a node to record
         * where the variable was read, to ensure subsequent writes are sequenced after
         * this read.
         * Instead, we could record the loadlocal in a mapping on the builder, and then
         * for *every* other instructions operands, check if they access that local and
         * if so record the read at that instruction.
         *
         * note that this would also have to use the above loadDeclarationControlForRead
         * as part of the instruction's controls. so overall, maybe easier to keep loadlocal
         * nodes
         */
        const node: LoadNode = {
          kind: 'Load',
          control: instructionControl,
          id: context.nextReactiveId,
          loc: value.loc,
          outputs: [],
          value: {
            node: source,
            from: value.place,
            as: lvalue,
          },
        };
        context.putNode(node);
        lastNode = node.id;
        context.storeTemporary(lvalue, node.id);
        // Record that we read so that subsequent writes can be sequenced after
        context.recordDeclarationRead(
          value.place.identifier.declarationId,
          node.id,
        );
      } else if (value.kind === 'StoreLocal') {
        /*
         * Determine the control, which is either the previous read/write in this context,
         * or the context's control
         */
        const instructionControl =
          context.loadDeclarationControlForWrite(
            value.lvalue.place.identifier.declarationId,
            value.lvalue.place.loc,
          ) ?? control;

        // Lookup the node that defines the temporary we're storing
        const valueNode = context.lookupTemporary(
          value.value.identifier,
          value.value.loc,
        );

        const node: StoreNode = {
          kind: 'Store',
          control: instructionControl,
          id: context.nextReactiveId,
          instructionKind: value.lvalue.kind,
          loc: value.loc,
          lvalue: value.lvalue.place,
          outputs: [],
          value: {
            node: valueNode,
            from: value.value,
            as: value.value,
          },
        };
        context.putNode(node);
        lastNode = node.id;
        context.storeTemporary(lvalue, node.id);
        // Record that the value was written so subsequent reads/writes can be sequenced after
        context.recordDeclarationWrite(
          value.lvalue.place.identifier.declarationId,
          node.id,
        );
      } else if (
        value.kind === 'DeclareLocal' ||
        value.kind === 'Destructure' ||
        value.kind === 'PrefixUpdate' ||
        value.kind === 'PostfixUpdate'
      ) {
        CompilerError.throwTodo({
          reason: `Support ${value.kind} instructions similarly to StoreLocal`,
          loc: value.loc,
        });
      } else if (
        value.kind === 'DeclareContext' ||
        value.kind === 'StoreContext' ||
        value.kind === 'LoadContext'
      ) {
        CompilerError.throwTodo({
          reason: `Support ${value.kind} instructions`,
          loc: value.loc,
        });
      } else {
        for (const _ of eachInstructionValueLValue(value)) {
          CompilerError.invariant(false, {
            reason: `Expected all lvalue-producing instructions to be special-cased (got ${value.kind})`,
            loc: value.loc,
          });
        }
        const instructionScope = getScopeForInstruction(instr);
        let instructionControl = control;
        if (instructionScope != null) {
          const previousScopeNode = context.loadScopeControl(
            instructionScope.id,
          );
          if (previousScopeNode != null) {
            instructionControl = previousScopeNode;
          }
        }

        const dependencies: NodeDependencies = new Map();
        for (const operand of eachInstructionValueOperand(instr.value)) {
          const dep = context.lookupTemporary(operand.identifier, operand.loc);
          dependencies.set(dep, {
            from: {...operand},
            as: {...operand},
          });
        }
        const node: InstructionNode = {
          kind: 'Value',
          control: instructionControl,
          dependencies,
          id: context.nextReactiveId,
          loc: instr.loc,
          outputs: [],
          value: instr,
        };
        context.putNode(node);
        lastNode = node.id;
        context.storeTemporary(lvalue, node.id);
        if (instructionScope != null) {
          context.recordScopeMutation(instructionScope.id, node.id);
        }
      }
    }

    // handle the terminal
    const terminal = block.terminal;
    switch (terminal.kind) {
      case 'return': {
        const valueDep = context.lookupTemporary(
          terminal.value.identifier,
          terminal.value.loc,
        );
        const value: NodeReference = {
          node: valueDep,
          from: {...terminal.value},
          as: {...terminal.value},
        };
        const returnNode: ReturnNode = {
          kind: 'Return',
          id: context.nextReactiveId,
          loc: terminal.loc,
          outputs: [],
          value,
          dependencies: context
            .uncontolledNodes()
            .filter(id => id !== valueDep),
          control,
        };
        context.putNode(returnNode);
        lastNode = returnNode.id;
        break;
      }
      case 'throw': {
        const valueDep = context.lookupTemporary(
          terminal.value.identifier,
          terminal.value.loc,
        );
        const value: NodeReference = {
          node: valueDep,
          from: {...terminal.value},
          as: {...terminal.value},
        };
        const throwNode: ThrowNode = {
          kind: 'Throw',
          id: context.nextReactiveId,
          loc: terminal.loc,
          outputs: [],
          value,
          dependencies: context
            .uncontolledNodes()
            .filter(id => id !== valueDep),
          control,
        };
        context.putNode(throwNode);
        lastNode = throwNode.id;
        break;
      }
      case 'goto': {
        let target: ReactiveId;
        switch (terminal.variant) {
          case GotoVariant.Break: {
            target = context.loadBreakTarget(terminal.block, terminal.loc);
            break;
          }
          case GotoVariant.Continue: {
            target = context.loadContinueTarget(terminal.block, terminal.loc);
            break;
          }
          case GotoVariant.Try: {
            CompilerError.throwTodo({
              reason: 'Support break with try variant',
              loc: terminal.loc,
            });
          }
          default: {
            assertExhaustive(
              terminal.variant,
              `Unexpected goto variant ${terminal.variant}`,
            );
          }
        }
        const node: GotoNode = {
          kind: 'Goto',
          id: context.nextReactiveId,
          loc: terminal.loc,
          outputs: [],
          target,
          variant: terminal.variant,
          dependencies: context.uncontolledNodes(),
          control,
        };
        context.putNode(node);
        context.putBreakMapping(block.id, node.id);
        lastNode = node.id;
        break;
      }
      case 'unreachable': {
        CompilerError.invariant(false, {
          reason: `Found unreachable code`,
          loc: terminal.loc,
        });
      }
      case 'unsupported': {
        CompilerError.invariant(false, {
          reason: `Found unsupported terminal`,
          loc: terminal.loc,
        });
      }
      case 'scope':
      case 'pruned-scope': {
        CompilerError.throwTodo({
          reason: `Support scopes`,
          loc: terminal.loc,
        });
      }
      case 'branch':
      case 'logical':
      case 'ternary':
      case 'sequence':
      case 'optional': {
        CompilerError.throwTodo({
          reason: `Support value blocks`,
          loc: terminal.loc,
        });
      }
      case 'try':
      case 'maybe-throw': {
        CompilerError.throwTodo({
          reason: `Support try/catch`,
          loc: terminal.loc,
        });
      }
      default: {
        lastNode = buildTerminal(fn, terminal, context, control);
        break;
      }
    }

    // Continue iteration in the fallthrough
    const fallthrough = terminalFallthrough(terminal);
    if (fallthrough != null) {
      block = fn.body.blocks.get(fallthrough)!;
    } else {
      break;
    }
  }
  return lastNode;
}

function buildTerminal(
  fn: HIRFunction,
  terminal:
    | DoWhileTerminal
    | ForInTerminal
    | ForOfTerminal
    | ForTerminal
    | IfTerminal
    | LabelTerminal
    | SwitchTerminal
    | WhileTerminal,
  context: ControlContext,
  control: ReactiveId,
): ReactiveId {
  let branches: Array<{
    enter: ReactiveId;
    exit: ReactiveId;
    context: ControlContext;
  }>;
  const fallthroughNodeId = context.nextReactiveId;
  let terminalNode: ReactiveNode;

  switch (terminal.kind) {
    case 'if': {
      const testDep = context.lookupTemporary(
        terminal.test.identifier,
        terminal.test.loc,
      );
      const test: NodeReference = {
        node: testDep,
        from: {...terminal.test},
        as: {...terminal.test},
      };
      const ifNodeId = context.nextReactiveId;
      const joinFallthrough = {
        kind: 'If',
        block: terminal.fallthrough,
        fallthrough: fallthroughNodeId,
      } as const;
      const consequentContext = context.fork(joinFallthrough);
      const consequentControl = consequentContext.controlNode(
        ifNodeId,
        terminal.loc,
      );
      const consequent = buildBlockScope(
        fn,
        consequentContext,
        terminal.consequent,
        consequentControl,
      );
      const alternateContext = context.fork(joinFallthrough);
      const alternateControl = alternateContext.controlNode(
        ifNodeId,
        terminal.loc,
      );
      const alternate =
        terminal.alternate !== terminal.fallthrough
          ? buildBlockScope(
              fn,
              alternateContext,
              terminal.alternate,
              alternateControl,
            )
          : alternateControl;

      const node: IfNode = {
        kind: 'If',
        control,
        dependencies: [],
        id: ifNodeId,
        loc: terminal.loc,
        outputs: [],
        fallthrough: fallthroughNodeId,
        test,
        consequent: {
          entry: consequentControl,
          exit: consequent,
        },
        alternate: {
          entry: alternateControl,
          exit: alternate,
        },
      };
      context.putNode(node);
      branches = [
        {
          enter: consequentControl,
          exit: consequent,
          context: consequentContext,
        },
        {
          enter: alternateControl,
          exit: alternate,
          context: alternateContext,
        },
      ];
      terminalNode = node;
      break;
    }
    case 'label': {
      const blockContext = context.fork({
        kind: 'Label',
        block: terminal.fallthrough,
        fallthrough: fallthroughNodeId,
      });
      const labelNodeId = context.nextReactiveId;
      const blockControl = blockContext.controlNode(labelNodeId, terminal.loc);
      const block = buildBlockScope(
        fn,
        blockContext,
        terminal.block,
        blockControl,
      );
      const node: LabelNode = {
        kind: 'Label',
        block: {entry: blockControl, exit: block},
        control,
        id: labelNodeId,
        loc: terminal.loc,
        outputs: [],
        dependencies: [],
      };
      context.putNode(node);
      branches = [{enter: blockControl, exit: block, context: blockContext}];
      terminalNode = node;
      break;
    }
    default: {
      assertExhaustive(
        terminal /* TODO */ as never,
        `Unexpected terminal kind '${(terminal as any).kind}'`,
      );
    }
  }
  const fallthrough = fn.body.blocks.get(terminal.fallthrough)!;
  const phis: Array<PhiNode> = Array.from(fallthrough.phis).map(phi => {
    return {
      kind: 'Phi',
      place: phi.place,
      operands: new Map(
        Array.from(phi.operands, ([blockId, operand]) => {
          return [context.getBreakMapping(blockId, phi.place.loc), operand];
        }),
      ),
    };
  });
  const fallthroughNode: FallthroughNode = {
    kind: 'Fallthrough',
    control: terminalNode.id,
    id: fallthroughNodeId,
    loc: terminal.loc,
    outputs: [],
    branches: branches.map(pred => pred.exit),
    phis,
  };
  context.putNode(fallthroughNode);

  const controlDependencies: Set<ReactiveId> = new Set();
  const joinedDeclarations: Map<DeclarationId, 'write' | 'read'> = new Map();
  const joinedScopes: Set<ScopeId> = new Set();
  for (const predecessorBlock of branches) {
    /*
     * track scopes that were mutated in any of the branches so that we can
     * establish control depends to order the branch/join relative to previous
     * subsequent mutations of those scopes
     */
    for (const [scope] of predecessorBlock.context.eachScope()) {
      joinedScopes.add(scope);
    }
    /*
     * Track variables that were read/reassigned in any of the predecessors
     * so that subsequent writes/reads can take the join node as a control
     */
    for (const [
      declarationId,
      {write, read},
    ] of predecessorBlock.context.eachDeclaration()) {
      if (write) {
        joinedDeclarations.set(declarationId, 'write');
      } else if (read && !joinedDeclarations.has(declarationId)) {
        joinedDeclarations.set(declarationId, 'read');
      }
    }
  }
  for (const scope of joinedScopes) {
    const scopeControl = context.loadScopeControl(scope);
    if (scopeControl != null) {
      controlDependencies.add(scopeControl);
    }
    context.recordScopeMutation(scope, fallthroughNode.id);
  }
  // Add control dependencies and record reads/writes accordingly.
  for (const [declarationId, declType] of joinedDeclarations) {
    if (declType === 'write') {
      /*
       * If there was a write in any of the branches, we take a write
       * dependency (on the last read/write) and record the if as the
       * last write
       */
      const writeControl = context.loadDeclarationControlForWrite(
        declarationId,
        terminal.loc,
      );
      if (writeControl != null) {
        controlDependencies.add(writeControl);
      }
      context.recordDeclarationWrite(declarationId, fallthroughNode.id);
    } else {
      /*
       * If there were only reads in the branches, we take a read
       * dependency (on the last write) and record the if as the
       * last read
       */
      const readControl = context.loadDeclarationControlForRead(declarationId);
      if (readControl != null) {
        controlDependencies.add(readControl);
      }
      context.recordDeclarationRead(declarationId, fallthroughNode.id);
    }
  }

  terminalNode.dependencies = Array.from(controlDependencies);
  return fallthroughNodeId;
}

function getScopeForInstruction(instr: Instruction): ReactiveScope | null {
  let scope: ReactiveScope | null = null;
  for (const operand of eachInstructionValueOperand(instr.value)) {
    if (
      operand.identifier.scope == null ||
      instr.id < operand.identifier.scope.range.start ||
      instr.id >= operand.identifier.scope.range.end
    ) {
      continue;
    }
    CompilerError.invariant(
      scope == null || operand.identifier.scope.id === scope.id,
      {
        reason: `Multiple scopes for instruction ${printInstruction(instr)}`,
        loc: instr.loc,
      },
    );
    scope = operand.identifier.scope;
  }
  return scope;
}
