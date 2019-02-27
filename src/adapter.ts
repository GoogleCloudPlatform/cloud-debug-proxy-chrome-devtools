/**
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as stackdriver from '@google-cloud/debug-proxy-common';
import {EventEmitter} from 'events';
import * as fs from 'fs';
import {Debugger, Runtime} from 'inspector';
import * as path from 'path';
import * as util from 'util';
import {loggers} from 'winston';

const readFileP = util.promisify(fs.readFile);

type Domain = 'Console'|'Debugger'|'HeapProfiler'|'Profiler'|'Runtime'|'Schema';
type DebuggerMethod =
    'continueToLocation'|'disable'|'enable'|'evaluateOnCallFrame'|
    'getPossibleBreakpoints'|'getScriptSource'|'getStackTrace'|'pause'|
    'pauseOnAsyncCall'|'removeBreakpoint'|'restartFrame'|'resume'|
    'scheduleStepIntoAsync'|'searchInContent'|'setAsyncCallStackDepth'|
    'setBlackboxPatterns'|'setBlackboxedRanges'|'setBreakpoint'|
    'setBreakpointByUrl'|'setBreakpointOnFunctionCall'|'setBreakpointsActive'|
    'setPauseOnExceptions'|'setReturnValue'|'setScriptSource'|
    'setSkipAllPauses'|'setVariableValue'|'stepInto'|'stepOut'|'stepOver';
type RuntimeMethod =
    'addBinding'|'awaitPromise'|'callFunctionOn'|'compileScript'|'disable'|
    'discardConsoleEntries'|'enable'|'evaluate'|'getIsolateId'|'getHeapUsage'|
    'getProperties'|'globalLexicalScopeNames'|'queryObjects'|'releaseObject'|
    'releaseObjectGroup'|'removeBinding'|'runIfWaitingForDebugger'|'runScript'|
    'setAsyncCallStackDepth'|'setCustomObjectFormatterEnabled'|
    'setMaxCallStackSizeToCapture'|'terminateExecution';
type Method = DebuggerMethod|RuntimeMethod;
type DebuggerEvent = 'Debugger.breakpointResolved'|'Debugger.paused'|
    'Debugger.resumed'|'Debugger.scriptFailedToParse'|'Debugger.scriptParsed';
type RuntimeEvent = 'Runtime.bindingCalled'|'Runtime.consoleAPICalled'|
    'Runtime.exceptionRevoked'|'Runtime.exceptionThrown'|
    'Runtime.executionContextCreated'|'Runtime.executionContextDestroyed'|
    'Runtime.executionContextsCleared'|'Runtime.inspectRequested';
type Event = DebuggerEvent|RuntimeEvent;

export type ZeroIndexedLineNumber = number;
type ZeroIndexedColumnNumber = number;
type MessageId = number;
type DebuggerId = number;

// TODO: Remove this when @types/node supports `EnableReturnType`.
// https://github.com/DefinitelyTyped/DefinitelyTyped/pull/28039
export interface EnableReturnType {
  debuggerId: DebuggerId;
}

type ProcessedResponse = {}|EnableReturnType|
                         Runtime.GetPropertiesReturnType|
                         Debugger.SetBreakpointByUrlReturnType;
export interface MessageRequest {
  id: MessageId;
  method: string;  // This string is of the form `${Domain}.${Method}`.
  params?: {}|Runtime.GetPropertiesParameterType|
      Debugger.RemoveBreakpointParameterType|
      Debugger.SetBreakpointByUrlParameterType;
}
export interface MessageResponse {
  id: MessageId;
  result: ProcessedResponse;
}
export interface MessageEvent {
  method: Event;
  params?: {}|Debugger.PausedEventDataType|Debugger.ScriptParsedEventDataType;
}

interface BreakpointInfo {
  name: string;
  id: string;
}

// https://chromedevtools.github.io/devtools-protocol/tot/Runtime#type-RemoteObject
const REMOTE_OBJECT_SUBTYPE_SET = new Set<string>([
  'array',
  'null',
  'node',
  'regexp',
  'date',
  'map',
  'set',
  'weakmap',
  'weakset',
  'iterator',
  'generator',
  'error',
  'proxy',
  'promise',
  'typedarray',
]);

// https://www.ecma-international.org/ecma-262/#table-49
const TYPED_ARRAY_SET = new Set<string>([
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
]);

// Add to this list if you are getting flooded with similar messages.
const STATUS_MESSAGE_SET = new Set<string>(
    ['baseUrl', '_pendingEncoding', 'search', '_trailer', '_url']);

/**
 * An adapter, which processes requests from Chrome DevTools.
 *
 * This adapter can communicate using the Chrome DevTools Protocol
 * and has a private instance of @google-cloud/debug-proxy-common.
 * https://chromedevtools.github.io/devtools-protocol/
 *
 * @fires 'resume' when DevTools sends a resume request
 * @fires 'loadSnapshot' when users request a snapshot
 * @fires 'updateBreakpointList' when the breakpoint list changes
 */
export class Adapter extends EventEmitter {
  // TODO: get() does not exist yet, will be resolved in Winston 3.1
  // https://github.com/winstonjs/winston/issues/1361
  // tslint:disable-next-line no-any
  private readonly logger = (loggers as any).get('devtools-logger');
  private readonly propertyDescriptorListMap =
      new Map<Runtime.RemoteObjectId, Runtime.PropertyDescriptor[]>();

  constructor(private readonly debugProxy: stackdriver.DebugProxy) {
    super();
    this.logger.verbose(
        {origin: 'adapter-init', message: 'Adapter successfully initialized.'});
    this.debugProxy.on('breakpointHit', () => {
      this.logger.verbose({
        origin: 'adapter-hit',
        message: 'Breakpoint list changed.',
      });
      this.emitUpdateBreakpointList();
    });
  }

  private devToolsToStackdriverLine(line: ZeroIndexedLineNumber):
      stackdriver.OneIndexedLineNumber {
    return line + 1;
  }

  private stackdriverToDevToolsLine(line: stackdriver.OneIndexedLineNumber):
      ZeroIndexedLineNumber {
    if (line < 1) {
      throw new Error(`Given Stackdriver line number ${line} is not possible.`);
    }
    return line - 1;
  }

  private breakpointToBreakpointInfo(breakpoint: stackdriver.Breakpoint):
      BreakpointInfo {
    return {
      name: `${breakpoint.location.path}:${breakpoint.location.line}`,
      id: breakpoint.id,
    };
  }

  private nonNull<T>(value: T|null): value is T {
    return value !== null;
  }

  /*
   * Given a variable with an status message, logs it.
   *
   * @param variable - variable with an status message
   */
  logVariableStatus(variable: stackdriver.Variable) {
    // TODO:
    // https://github.com/GoogleCloudPlatform/cloud-debug-proxy-chrome-devtools/issues/1
    if (variable.status) {
      // The variable has a proper status message and should have this format.
      if (!variable.varTableIndex && variable.status.isError === true &&
          variable.status.refersTo === 'VARIABLE_VALUE' &&
          variable.status.description && variable.status.description.format) {
        this.logger.silly({
          origin: 'adapter-parse',
          message: `Error in variable '${variable.name}' from Stackdriver ` +
              `Debug, status message: ${variable.status.description.format}`,
        });
      } else {
        throw new Error(
            'The following variable from Stackdriver Debug has an ' +
            `unexpected format: ${util.inspect(variable, {depth: null})}`);
      }
    } else if (variable.name && STATUS_MESSAGE_SET.has(variable.name)) {
      // The variable has no properties but its name, which can be ignored.
      this.logger.silly({
        origin: 'adapter-parse',
        message: `Status message: ${util.inspect(variable, {depth: null})}`,
      });
    } else {
      /* The variable does not have a proper status message, but its name may
       * be a status message for some strange undocumented reason, such as:
       * "Only first `capture.maxProperties=1000` properties were captured."
       */
      this.logger.info({
        origin: 'adapter-parse',
        message: `Status message: ${util.inspect(variable, {depth: null})}`,
      });
    }
  }

  /*
   * Figure out what value the given string represents.
   *
   * Currently, it is impossible to differentiate `null` from `'null'`,
   * `42` from `'42'`, and actual functions from the string `'function ()'`,
   * because their string values returned by Stackdriver Debug are the same.
   *
   * @param value - string from Stackdriver Debug representing a value
   * @returns remote object whose value is that which the string represents
   */
  parseVariableValue(value: string): Runtime.RemoteObject {
    // TODO:
    // https://github.com/GoogleCloudPlatform/cloud-debug-proxy-chrome-devtools/issues/1
    switch (value) {
      case 'undefined':
        return {type: 'undefined'};
      case 'null':
        return {type: 'object', subtype: 'null', value: null};
      case 'true':
        return {type: 'boolean', value: true};
      case 'false':
        return {type: 'boolean', value: false};
      case 'NaN':
      case 'Infinity':
      case '-Infinity':
        return {
          type: 'number',
          description: value,
          unserializableValue: value,
        };
      default:
        break;
    }
    if (value.startsWith('Symbol(') && value.endsWith(')')) {
      return {
        type: 'symbol',
        description: value,
      };
    }
    if (value.startsWith('function ') && value.endsWith('()')) {
      return {
        type: 'function',
        className: 'Function',
        description: value + '{}',  // DevTools wants the whole function body.
      };
    }
    if (value.startsWith('/') && value.endsWith('/')) {
      return {
        type: 'object',
        subtype: 'regexp',
        className: 'RegExp',
        description: value,
      };
    }
    if (!Number.isNaN(Number(value))) {
      return {
        type: 'number',
        description: value,
        value: Number(value),
      };
    }
    // TODO: Parse BigInts.
    return {
      type: 'string',
      value,
    };
  }

  /** Continually polls the list of pending breakpoints. */
  async pollForPendingBreakpoints(): Promise<never> {
    while (true) {
      await this.debugProxy.updatePendingBreakpoints(true);
    }
  }

  /** @returns path to the selected source directory */
  getSourceDirectory() {
    return this.debugProxy.options.sourceDirectory;
  }

  /** @fires 'loadSnapshot' with the given snapshot ID */
  emitLoadSnapshot(snapshotId: stackdriver.BreakpointId) {
    this.emit('loadSnapshot', snapshotId);
  }

  /** @fires 'updateBreakpointList' with the current breakpoint info lists */
  emitUpdateBreakpointList() {
    const pendingBreakpointInfoList: BreakpointInfo[] =
        this.debugProxy.getBreakpointList(false).map(
            this.breakpointToBreakpointInfo);
    const capturedSnapshotInfoList: BreakpointInfo[] =
        this.debugProxy.getBreakpointList(true).map(
            this.breakpointToBreakpointInfo);
    this.emit('updateBreakpointList', {
      pendingBreakpointInfoList,
      capturedSnapshotInfoList,
    });
  }

  /**
   * Processes requests from Chrome DevTools.
   *
   * @param request - request from Chrome DevTools
   * @returns response to request from Chrome DevTools
   */
  async processRequest(request: MessageRequest): Promise<ProcessedResponse> {
    const [domain, method] = request.method.split('.', 2) as [Domain, Method];
    if (domain === 'Debugger') {
      // https://chromedevtools.github.io/devtools-protocol/tot/Debugger
      const debuggerMethod = method as DebuggerMethod;
      switch (debuggerMethod) {
        case 'enable':
          return {debuggerId: this.debugProxy.getDebuggerId()};
        case 'getScriptSource':
          const getScriptSourceRequest =
              request.params as Debugger.GetScriptSourceParameterType;
          // parse-scripts.ts makes  `scriptId` an absolute path to the file.
          return {
            scriptSource:
                await readFileP(getScriptSourceRequest.scriptId, 'utf8'),
          };
        case 'removeBreakpoint':
          const removeBreakpointRequest =
              request.params as Debugger.RemoveBreakpointParameterType;
          await this.debugProxy.removeBreakpoint(
              removeBreakpointRequest.breakpointId);
          return {};
        case 'resume':
          this.emit('resume');
          return {};
        case 'setBreakpointByUrl':
          const setBreakpointByUrlRequest =
              request.params as Debugger.SetBreakpointByUrlParameterType;
          let breakpoint: stackdriver.Breakpoint;
          // TODO: setBreakpointByUrl request is valid with `urlRegex` property.
          if (!setBreakpointByUrlRequest.url) {
            throw new Error(
                'The setBreakpointByUrl request from Chrome DevTools should ' +
                'specify the `url` property.');
          } else {
            breakpoint = await this.debugProxy.setBreakpoint({
              action: stackdriver.Action.CAPTURE,
              location: {
                path: setBreakpointByUrlRequest.url,
                line: this.devToolsToStackdriverLine(
                    setBreakpointByUrlRequest.lineNumber),
              },
              condition: setBreakpointByUrlRequest.condition,
            });
          }
          this.emitUpdateBreakpointList();
          return {
            breakpointId: breakpoint.id,
            locations: [{
              scriptId: breakpoint.location.path,
              lineNumber:
                  this.stackdriverToDevToolsLine(breakpoint.location.line),
              columnNumber: 0,
            }]
          };
        case 'continueToLocation':
        case 'evaluateOnCallFrame':
        case 'restartFrame':
        case 'scheduleStepIntoAsync':
        case 'setReturnValue':
        case 'setScriptSource':
        case 'setVariableValue':
        case 'stepInto':
        case 'stepOut':
        case 'stepOver':
          throw new Error(
              `The \`${request.method}\` request from Chrome DevTools ` +
              `is not supported: ${util.inspect(request, {depth: null})}`);
        // These methods have no effect and do not require a response.
        case 'disable':
        case 'pause':
        case 'pauseOnAsyncCall':
        case 'setAsyncCallStackDepth':
        case 'setBlackboxedRanges':
        case 'setBlackboxPatterns':
        case 'setBreakpointsActive':
        case 'setPauseOnExceptions':
        case 'setSkipAllPauses':
          return {};
        // TODO: Implement all the other methods.
        case 'getPossibleBreakpoints':
        case 'getStackTrace':
        case 'searchInContent':
        case 'setBreakpoint':
        case 'setBreakpointOnFunctionCall':
          return {};
        default:
          // Cast to never to check that all cases are covered at compile-time.
          const _: never = debuggerMethod;
          throw new Error(`Unrecognized debugger method: ${debuggerMethod}`);
      }
    } else if (domain === 'Runtime') {
      // https://chromedevtools.github.io/devtools-protocol/tot/Runtime
      const runtimeMethod = method as RuntimeMethod;
      switch (runtimeMethod) {
        case 'getProperties':
          const getPropertiesRequest =
              request.params as Runtime.GetPropertiesParameterType;
          const propertyDescriptorList =
              this.propertyDescriptorListMap.get(getPropertiesRequest.objectId);
          if (propertyDescriptorList === undefined) {
            throw new Error(
                `The remote object with ID ${getPropertiesRequest.objectId} ` +
                'does not exist in the internal object property map.');
          }
          return {result: propertyDescriptorList};
        case 'addBinding':
        case 'awaitPromise':
        case 'callFunctionOn':
        case 'compileScript':
        case 'evaluate':
        case 'getIsolateId':
        case 'getHeapUsage':
        case 'globalLexicalScopeNames':
        case 'queryObjects':
        case 'removeBinding':
        case 'runScript':
        case 'terminateExecution':
          throw new Error(
              `The \`${request.method}\` request from Chrome DevTools ` +
              `is not supported: ${util.inspect(request, {depth: null})}`);
        // These methods have no effect and do not require a response.
        case 'disable':
        case 'discardConsoleEntries':
        case 'enable':
        case 'releaseObject':
        case 'releaseObjectGroup':
        case 'runIfWaitingForDebugger':
        case 'setAsyncCallStackDepth':
        case 'setCustomObjectFormatterEnabled':
        case 'setMaxCallStackSizeToCapture':
          return {};
        default:
          // Cast to never to check that all cases are covered at compile-time.
          const _: never = runtimeMethod;
          throw new Error(`Unrecognized runtime method: ${runtimeMethod}`);
      }
    } else {
      // TODO: Implement all the other domains.
      return {};
    }
  }

  /**
   * Loads a snapshot from Stackdriver Debug into Chrome DevTools.
   *
   * @param snapshotId - ID of the snapshot to be loaded
   * @returns event to send to Chrome DevTools
   */
  async loadSnapshot(snapshotId: stackdriver.BreakpointId):
      Promise<Debugger.PausedEventDataType> {
    const nonNull = this.nonNull;
    const logVariableStatus = this.logVariableStatus;
    const parseVariableValue = this.parseVariableValue;
    const varTableIndexToRemoteObjectMap =
        new Map<number, Runtime.RemoteObject>();
    const snapshot = await this.debugProxy.getBreakpoint(snapshotId) as
        stackdriver.CapturedSnapshot;
    snapshot.stackFrames = snapshot.stackFrames || [];
    snapshot.variableTable = snapshot.variableTable || [];
    if (!snapshot.isFinalState) {
      throw new Error(
          'The following breakpoint from Stackdriver Debug is not ' +
          `a captured snapshot: ${util.inspect(snapshot, {depth: null})}`);
    }

    function getObjectId(varTableIndex: number): Runtime.RemoteObjectId {
      return `${snapshot.id}-object-${varTableIndex}`;
    }

    function parseVariable(variable: stackdriver.Variable):
        Runtime.PropertyDescriptor|null {
      if (variable.type || variable.members) {
        throw new Error(
            'The following variable from Stackdriver Debug ' +
            'should not have the `type` nor `members` properties: ' +
            util.inspect(variable, {depth: null}));
      }
      if (variable.value && variable.varTableIndex) {
        throw new Error(
            'The following Variable from Stackdriver Debug should not have ' +
            'the `value` property, because it already specifies the `var' +
            'TableIndex` property: ' + util.inspect(variable, {depth: null}));
      }
      if (variable.value || variable.varTableIndex) {
        if (!variable.name) {
          throw new Error(
              'The following Variable from Stackdriver Debug should have ' +
              'the `name` property: ' + util.inspect(variable, {depth: null}));
        }
        return {
          name: variable.name,
          configurable: false,
          enumerable: true,
          value: variable.value ?
              parseVariableValue(variable.value) :
              varTableIndexToRemoteObjectMap.get(variable.varTableIndex!),
        };
      }
      logVariableStatus(variable);
      return null;
    }

    function parseVariableList(list: stackdriver.Variable[]):
        Runtime.PropertyDescriptor[] {
      return list.map(parseVariable).filter(nonNull);
    }

    snapshot.variableTable.forEach(
        (variable: stackdriver.Variable, index: number) => {
          if (variable.name || variable.type || variable.varTableIndex) {
            throw new Error(
                'The following entry in the `variableTable` from Stackdriver ' +
                'Debug should not have the `name`, `type`, nor `varTableIndex` ' +
                `properties: ${util.inspect(variable, {depth: null})}`);
          }
          if (variable.value) {
            // TODO:
            // https://github.com/GoogleCloudPlatform/cloud-debug-proxy-chrome-devtools/issues/1
            // `variable.value` specifies the subtype, e.g. `#<Array>`
            let className: string|undefined;
            let subtype: string|undefined;
            let description: string|undefined;
            let objectId: Runtime.RemoteObjectId|undefined;
            if (variable.value.startsWith('#<') &&
                variable.value.endsWith('>')) {
              className = variable.value.substr(2, variable.value.length - 3);
              if (REMOTE_OBJECT_SUBTYPE_SET.has(className.toLowerCase())) {
                subtype = className.toLowerCase();
                if (subtype === 'array') {
                  if (variable.members) {
                    for (const member of variable.members) {
                      if (member.name === 'length') {
                        description = `Array(${member.value})`;
                        break;
                      }
                    }
                  }
                  if (!description) {
                    throw new Error(
                        'The following array variable from Stackdriver ' +
                        'Debug does not have the `length` property: ' +
                        util.inspect(variable, {depth: null}));
                  }
                } else {
                  description = className;
                }
              } else {
                description = className;
                if (TYPED_ARRAY_SET.has(className)) {
                  subtype = 'typedarray';
                }
              }
            } else if (variable.value.startsWith('Error')) {
              className = 'Error';
              subtype = 'error';
              description = className;
              if (variable.members) {
                for (const member of variable.members) {
                  if (member.name === 'stack' && member.value) {
                    description = member.value;
                    break;
                  }
                }
              } else {
                throw new Error(
                    'The following error variable from Stackdriver ' +
                    'Debug does not have the `stack` property: ' +
                    util.inspect(variable, {depth: null}));
              }
            } else {
              const possibleDateMs = Date.parse(variable.value);
              if (!Number.isNaN(possibleDateMs) &&
                  variable.value === new Date(possibleDateMs).toISOString()) {
                className = 'Date';
                subtype = 'date';
                description = new Date(possibleDateMs).toString();
              } else {
                throw new Error(
                    'The following variable from Stackdriver Debug has an un' +
                    `expected value: ${util.inspect(variable, {depth: null})}`);
              }
            }
            if (variable.members) {
              objectId = getObjectId(index);
            } else if (className === 'Object') {
              const emptyObjectId = `${snapshot.id}-empty-${index}`;
              this.propertyDescriptorListMap.set(emptyObjectId, []);
              objectId = emptyObjectId;
            }
            varTableIndexToRemoteObjectMap.set(index, {
              type: 'object',
              className,
              subtype,
              description,
              objectId,
            });
          } else {
            this.logVariableStatus(variable);
          }
        });

    snapshot.variableTable.forEach(
        (variable: stackdriver.Variable, index: number) => {
          if (variable.type || variable.varTableIndex) {
            throw new Error(
                'The following entry in the `variableTable` from Stackdriver ' +
                'Debug should not itself have the `type` nor `varTableIndex` ' +
                `properties: ${util.inspect(variable, {depth: null})}`);
          }
          if (variable.value) {
            const propertyDescriptorList =
                variable.members ? parseVariableList(variable.members) : [{
                  name: variable.value,
                  value: varTableIndexToRemoteObjectMap.get(index),
                  configurable: false,
                  enumerable: true,
                }];
            this.propertyDescriptorListMap.set(
                getObjectId(index), propertyDescriptorList);
          }
        });

    return {
      reason: 'other',
      hitBreakpoints: [snapshot.id],
      callFrames: snapshot.stackFrames.map(
          (stackFrame: stackdriver.StackFrame,
           index: number): Debugger.CallFrame => {
            const scopeId = `${snapshot.id}-scope-${index}`;
            const contextId = `${snapshot.id}-context-${index}`;
            const propertyList: Runtime.PropertyDescriptor[] = [];
            let contextRemoteObject: Runtime.RemoteObject|undefined;
            if (stackFrame.locals) {
              if (stackFrame.locals.length > 0) {
                const contextVariable =
                    stackFrame.locals[stackFrame.locals.length - 1];
                if (contextVariable.name === 'context' &&
                    contextVariable.varTableIndex) {
                  contextRemoteObject = varTableIndexToRemoteObjectMap.get(
                      contextVariable.varTableIndex);
                  stackFrame.locals.pop();
                }
              }
              propertyList.push(...parseVariableList(stackFrame.locals));
            }
            if (stackFrame.arguments) {
              throw new Error(
                  'The following stack frame from Stackdriver Debug has ' +
                  `arguments: ${util.inspect(stackFrame, {depth: null})}`);
            }
            this.propertyDescriptorListMap.set(scopeId, propertyList);
            return {
              callFrameId: `${snapshot.id}-frame-${index}`,
              functionName: stackFrame.function,
              location: {
                scriptId: path.resolve(
                    this.debugProxy.options.sourceDirectory,
                    stackFrame.location.path),
                lineNumber:
                    this.stackdriverToDevToolsLine(stackFrame.location.line),
              },
              scopeChain: [{
                type: 'local',
                object: {type: 'object', objectId: scopeId},
              }],
              this: contextRemoteObject || {type: 'undefined'},
            };
          }),
    };
  }
}
