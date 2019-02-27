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
import * as http from 'http';
import {loggers} from 'winston';
import * as WebSocket from 'ws';
import * as devtools from './adapter';
import {parseScripts} from './parse-scripts';

interface ExtensionMessage {
  name: string;
  data: string;
}

export function serveDevTools(server: http.Server, adapter: devtools.Adapter) {
  // TODO: get() does not exist yet, will be resolved in Winston 3.1
  // https://github.com/winstonjs/winston/issues/1361
  // tslint:disable-next-line no-any
  const logger = (loggers as any).get('devtools-logger');
  logger.info({
    origin: 'wsdevtools-init',
    message: 'Waiting for WebSocket connection...'
  });

  const wss = new WebSocket.Server({server});
  wss.on('connection', async (ws: WebSocket) => {
    logger.info({
      origin: 'wsdevtools-init',
      message: 'Initialization complete. Listening for WebSocket messages...',
    });
    function sendEvent(messageObject: devtools.MessageEvent) {
      const message = JSON.stringify(messageObject);
      logger.verbose({origin: 'wsdevtools-event', message});
      ws.send(message);
    }
    function sendResponse(messageObject: devtools.MessageResponse) {
      const message = JSON.stringify(messageObject);
      logger.verbose({origin: 'wsdevtools-response', message});
      ws.send(message);
    }
    ws.on('message', async (message: string) => {
      logger.verbose({origin: 'wsdevtools-request', message});
      const request: devtools.MessageRequest = JSON.parse(message);
      try {
        const result = await adapter.processRequest(request);
        sendResponse({id: request.id, result});
      } catch (error) {
        logger.error({
          origin: 'wsdevtools-error',
          message: error.stack,
        });
      }
    });
    adapter.on('resume', () => sendEvent({method: 'Debugger.resumed'}));
    adapter.on('loadSnapshot', async (snapshotId) => {
      sendEvent({
        method: 'Debugger.paused',
        params: await adapter.loadSnapshot(snapshotId),
      });
    });
    await parseScripts(sendEvent, adapter.getSourceDirectory());
    await adapter.pollForPendingBreakpoints();
  });
  wss.on('error', (error: NodeJS.ErrnoException) => {
    logger.error({
      origin: 'wsdevtools-exception',
      message: error.stack,
    });
  });
}

export function serveExtension(port: number, adapter: devtools.Adapter) {
  // TODO: get() does not exist yet, will be resolved in Winston 3.1
  // https://github.com/winstonjs/winston/issues/1361
  // tslint:disable-next-line no-any
  const logger = (loggers as any).get('devtools-logger');
  logger.info({
    origin: 'wsextension-init',
    message: `Connect to port ${port} in the Snapshot Explorer...`,
  });
  const wss = new WebSocket.Server({port});
  wss.on('connection', (ws: WebSocket) => {
    logger.info({
      origin: 'wsextension-init',
      message: 'Initialization complete. Listening for WebSocket messages...',
    });
    ws.on('message', async (message: string) => {
      logger.verbose({
        origin: 'wsextension-response',
        message: `Received: ${message}`,
      });
      const request: ExtensionMessage = JSON.parse(message);
      switch (request.name) {
        case 'initialized':
          adapter.emitUpdateBreakpointList();
          break;
        case 'acknowledged':
          break;
        case 'loadSnapshot':
          adapter.emitLoadSnapshot(request.data);
          break;
        default:
          logger.error({
            origin: 'wsextension-request',
            message: `Received unknown request: ${message}`,
          });
      }
    });
    adapter.on('updateBreakpointList', (breakpointInfoLists) => {
      const message = JSON.stringify(
          {name: 'updateBreakpointInfoLists', data: breakpointInfoLists});
      logger.verbose({
        origin: 'wsextension-request',
        message: `Sending:  ${message}`,
      });
      ws.send(message);
    });
  });
  wss.on('error', (error: NodeJS.ErrnoException) => {
    logger.error({
      origin: 'wsextension-exception',
      message: error.stack,
    });
  });
}
