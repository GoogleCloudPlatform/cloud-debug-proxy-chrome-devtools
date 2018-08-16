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

export function serveWebSocket(server: http.Server, adapter: devtools.Adapter) {
  // TODO: get() does not exist yet, will be resolved in Winston 3.1
  // https://github.com/winstonjs/winston/issues/1361
  // tslint:disable-next-line no-any
  const logger = (loggers as any).get('devtools-logger');
  logger.info({
    origin: 'websocket-init',
    message: 'Waiting for WebSocket connection...'
  });

  const wss = new WebSocket.Server({server});
  wss.on('connection', async (ws: WebSocket) => {
    logger.info({
      origin: 'websocket-init',
      message: 'Initialization complete. Listening for WebSocket messages...',
    });
    function sendEvent(messageObject: devtools.MessageEvent) {
      const message = JSON.stringify(messageObject);
      logger.verbose({origin: 'websocket-event', message});
      ws.send(message);
    }
    function sendResponse(messageObject: devtools.MessageResponse) {
      const message = JSON.stringify(messageObject);
      logger.verbose({origin: 'websocket-response', message});
      ws.send(message);
    }
    ws.on('message', async (message: string) => {
      logger.verbose({origin: 'websocket-request', message});
      const request: devtools.MessageRequest = JSON.parse(message);
      try {
        const result = await adapter.processRequest(request);
        sendResponse({id: request.id, result});
      } catch (error) {
        logger.error({
          origin: 'websocket-error',
          message: error.stack,
        });
      }
    });
    adapter.on('resume', () => sendEvent({method: 'Debugger.resumed'}));
    await parseScripts(sendEvent, adapter.getSourceDirectory());
    await adapter.pollForPendingBreakpoints();
  });
  wss.on('error', (error: NodeJS.ErrnoException) => {
    logger.error({
      origin: 'websocket-exception',
      message: error.stack,
    });
  });
}
