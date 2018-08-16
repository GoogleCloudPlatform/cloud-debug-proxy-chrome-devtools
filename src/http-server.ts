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
import * as path from 'path';
import {loggers} from 'winston';

export function serveHttp(portNumber: number): http.Server {
  // TODO: get() does not exist yet, will be resolved in Winston 3.1
  // https://github.com/winstonjs/winston/issues/1361
  // tslint:disable-next-line no-any
  const logger = (loggers as any).get('devtools-logger');
  logger.info({
    origin: 'http-init',
    message: `Initializing HTTP server on port ${portNumber}...`,
  });

  const frontendUrl = 'chrome-devtools://devtools/' +
      `bundled/inspector.html?ws=localhost:${portNumber}`;
  const server = http.createServer(
      (request: http.IncomingMessage, response: http.ServerResponse) => {
        let responseBody: string;
        if (request.url === '/json') {
          responseBody = JSON.stringify([{
            description:
                'Node.js proxy between Chrome DevTools and Stackdriver Debug',
            devtoolsFrontendUrl: frontendUrl,
            faviconUrl: 'https://cloud.google.com/images/gcp-favicon.ico',
            title: `cloud-debug-proxy-devtools[${process.pid}]`,
            type: 'node',
            webSocketDebuggerUrl: `ws://localhost:${portNumber}`,
          }]);
          response.writeHead(200, {
            'Content-Type': 'application/json; charset=UTF-8',
            'Content-Length': Buffer.byteLength(responseBody),
          });
        } else {
          responseBody = '404 Not Found';
          response.writeHead(404, {
            'Content-Type': 'text/plain; charset=UTF-8',
            'Content-Length': Buffer.byteLength(responseBody),
          });
        }
        response.write(responseBody);
        response.end();
      });
  server.on('error', (error: NodeJS.ErrnoException) => {
    switch (error.code) {
      case 'EACCES':
        throw new Error(`Permission denied on port ${portNumber}.`);
      case 'EADDRINUSE':
        throw new Error(`Port ${portNumber} is already in use.`);
      default:
        throw new Error(`Unhandled error: ${error.code}.`);
    }
  });

  server.listen(portNumber, 'localhost');
  logger.info({
    origin: 'http-init',
    message: `Connect to Chrome DevTools at ${frontendUrl}`,
  });
  return server;
}
