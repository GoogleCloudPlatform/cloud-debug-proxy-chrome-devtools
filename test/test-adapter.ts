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
import * as assert from 'assert';
import {Debugger} from 'inspector';
import * as nock from 'nock';
import {loggers} from 'winston';
import * as devtools from '../src/adapter';
import {setupLogger} from '../src/logger';
import * as nocks from './nocks';

const assertRejects = require('assert-rejects');

const DEBUGGER_ID = 'test-debugger-id';
const DEBUGGEE_ID = 'test-debuggee-id';
const BREAKPOINT_ID = 'test-breakpoint-id';
const SOURCE_DIRECTORY = 'source-directory';
const SOURCE_URL = 'source-url';
const SOURCE_PATH = '/home/test/source/path';
const STACKDRIVER_URL = 'https://clouddebugger.googleapis.com';
const API_URL = '/v2/debugger';

interface NockObject {
  scope: nock.Scope;
  interceptor: nock.Interceptor;
}

function nockDebuggeesList(): NockObject {
  const scope = nock(STACKDRIVER_URL);
  const url = API_URL + '/debuggees';
  return {scope, interceptor: scope.get(url)};
}

function nockDebuggeesBreakpointsDelete(breakpointId: stackdriver.BreakpointId):
    NockObject {
  const scope = nock(STACKDRIVER_URL);
  const url = API_URL + `/debuggees/${DEBUGGEE_ID}/breakpoints/${breakpointId}`;
  return {scope, interceptor: scope.delete(url)};
}

function nockDebuggeesBreakpointsGet(breakpointId: stackdriver.BreakpointId):
    NockObject {
  const scope = nock(STACKDRIVER_URL);
  const url = API_URL + `/debuggees/${DEBUGGEE_ID}/breakpoints/${breakpointId}`;
  return {scope, interceptor: scope.get(url)};
}

function nockDebuggeesBreakpointsList(): NockObject {
  const scope = nock(STACKDRIVER_URL);
  const url = API_URL + `/debuggees/${DEBUGGEE_ID}/breakpoints`;
  return {scope, interceptor: scope.get(url)};
}

function nockDebuggeesBreakpointsSet(): NockObject {
  const scope = nock(STACKDRIVER_URL);
  const url = API_URL + `/debuggees/${DEBUGGEE_ID}/breakpoints/set`;
  return {scope, interceptor: scope.post(url)};
}

describe('adapter.ts', () => {
  let adapter: devtools.Adapter;
  let logger;

  before(() => {
    setupLogger('silly', 'test-adapter.log', false);
    // TODO: get() does not exist yet, will be resolved in Winston 3.1
    // https://github.com/winstonjs/winston/issues/1361
    // tslint:disable-next-line no-any
    logger = (loggers as any).get('devtools-logger');
  });

  beforeEach(async () => {
    const debugProxy = new stackdriver.DebugProxy({
      debuggerId: DEBUGGER_ID,
      sourceDirectory: SOURCE_DIRECTORY,
    });
    await debugProxy.setProjectByKeyFile('./test/fixtures/keyfile.json');
    await debugProxy.setDebuggeeId(DEBUGGEE_ID);
    adapter = new devtools.Adapter(debugProxy);
  });

  describe('enable', () => {
    it('should send the debugger ID', async () => {
      const response = await adapter.processRequest({
        id: 0,
        method: 'Debugger.enable',
      }) as devtools.EnableReturnType;
      assert.strictEqual(response.debuggerId, DEBUGGER_ID);
    });
  });

  describe('setBreakpointByUrl', () => {
    let oauthScope: nock.Scope;

    beforeEach(() => {
      oauthScope = nocks.oauth2();
    });

    afterEach(() => nock.cleanAll());

    it('should throw on empty request',
       () => assertRejects(adapter.processRequest({
         id: 0,
         method: 'Debugger.setBreakpointByUrl',
       })));

    it('should throw on invalid request',
       () => assertRejects(adapter.processRequest({
         id: 0,
         method: 'Debugger.setBreakpointByUrl',
         params: {
           lineNumber: 0,
           scriptHash: '',
           columnNumber: 0,
           condition: '',
         },
       })));

    // TODO: implement urlRegex, then remove this test
    it('should throw on invalid request with urlRegex',
       () => assertRejects(adapter.processRequest({
         id: 0,
         method: 'Debugger.setBreakpointByUrl',
         params: {
           lineNumber: 0,
           urlRegex: '',
           scriptHash: '',
           columnNumber: 0,
           condition: '',
         },
       })));

    it('should set breakpoints 1', async () => {
      const {scope, interceptor} = nockDebuggeesBreakpointsSet();
      interceptor.reply(200, {
        breakpoint: {
          id: BREAKPOINT_ID,
          isFinalState: true,
          location: {
            path: SOURCE_URL,
            line: 0 + 1,
          },
        },
      });
      const response = await adapter.processRequest({
        id: 0,
        method: 'Debugger.setBreakpointByUrl',
        params: {
          lineNumber: 0,
          url: SOURCE_URL,
        }
      }) as Debugger.SetBreakpointByUrlReturnType;
      assert(
          response.breakpointId && typeof response.breakpointId === 'string');
      assert.deepStrictEqual(response.locations, [{
                               scriptId: SOURCE_URL,
                               lineNumber: 0,
                               columnNumber: 0,
                             }]);
      scope.done();
      oauthScope.done();
    });

    it('should set breakpoints 2', async () => {
      const {scope, interceptor} = nockDebuggeesBreakpointsSet();
      interceptor.reply(200, {
        breakpoint: {
          action: stackdriver.Action.LOG,
          id: BREAKPOINT_ID,
          location: {
            path: SOURCE_PATH,
            line: 1337 + 1,
          },
        },
      });
      const response = await adapter.processRequest({
        id: 0,
        method: 'Debugger.setBreakpointByUrl',
        params: {
          lineNumber: 1337,
          url: SOURCE_PATH,
          urlRegex: '*',
          scriptHash: '#',
          columnNumber: 42,
          condition: 'false',
        }
      }) as Debugger.SetBreakpointByUrlReturnType;
      assert(
          response.breakpointId && typeof response.breakpointId === 'string');
      assert.deepStrictEqual(response.locations, [{
                               scriptId: SOURCE_PATH,
                               lineNumber: 1337,
                               columnNumber: 0,
                             }]);
      scope.done();
      oauthScope.done();
    });
  });

  describe('setBreakpointsActive', () => {
    it('should send an empty response on active', async () => {
      const response = await adapter.processRequest({
        id: 0,
        method: 'Debugger.setBreakpointsActive',
        params: {active: true},
      });
      assert.deepStrictEqual(response, {});
    });
    it('should send an empty response on inactive', async () => {
      const response = await adapter.processRequest({
        id: 0,
        method: 'Debugger.setBreakpointsActive',
        params: {active: false},
      });
      assert.deepStrictEqual(response, {});
    });
  });

  describe('miscellaneous', () => {
    const unimplementedMethods = [
      'getPossibleBreakpoints',
      'getStackTrace',
      'searchInContent',
      'setBreakpoint',
      'setBreakpointOnFunctionCall',
    ];
    const emptyMethods = [
      'disable',
      'pause',
      'pauseOnAsyncCall',
      'setAsyncCallStackDepth',
      'setBlackboxedRanges',
      'setBlackboxPatterns',
      'setBreakpointsActive',
      'setPauseOnExceptions',
      'setSkipAllPauses',
    ];
    const unimplementableMethods = [
      'continueToLocation',
      'evaluateOnCallFrame',
      'restartFrame',
      'setReturnValue',
      'setScriptSource',
      'setVariableValue',
      'stepInto',
      'stepOut',
      'stepOver',
    ];
    it('should send an empty response for unimplemented methods', async () => {
      const responseList = await Promise.all(unimplementedMethods.map(
          (method, index) => adapter.processRequest(
              {id: index, method: `Debugger.${method}`})));
      for (const response of responseList) {
        assert.deepStrictEqual(response, {});
      }
    });
    it('should send an empty response for empty methods', async () => {
      const responseList = await Promise.all(emptyMethods.map(
          (method, index) => adapter.processRequest(
              {id: index, method: `Debugger.${method}`})));
      for (const response of responseList) {
        assert.deepStrictEqual(response, {});
      }
    });
    it('should throw for unimplementable methods', async () => {
      const responseList = await Promise.all(unimplementableMethods.map(
          (method, index) => assertRejects(
              adapter.processRequest({id: index, method: `Debugger.${method}`}),
              /request from Chrome DevTools is not supported:/)));
    });
  });
});
