#!/usr/bin/env node
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
import 'hard-rejection/register';
import * as stackdriver from '@google-cloud/debug-proxy-common';
import * as http from 'http';
import * as inquirer from 'inquirer';
import * as meow from 'meow';
import * as updateNotifier from 'update-notifier';
import * as uuidv4 from 'uuid/v4';
import * as winston from 'winston';
import {Adapter} from './adapter';
import {setupLogger} from './logger';
import {serveHttp} from './http-server';
import {serveWebSocket} from './websocket-server';

export {Adapter} from './adapter';

const pkg = require('../../package.json');

const DEFAULT_SOURCE_DIRECTORY = './';
const DEFAULT_PORT = '9229';
const MINIMUM_PORT = 0;
const MAXIMUM_PORT = 65535;
const DEFAULT_LOGFILE = 'cloud-debug-proxy-devtools.log';
const DEFAULT_LOGLEVEL = 'info';

const cli = meow(
    `
  Usage
    $ cloud-debug-nodejs-devtools [options]

  Options
    --keyfile     The file with the Google Cloud JSON service account key.
    --project     The project ID in Google Cloud, if keyfile is not specified.
    --default     Set this to true to use Application Default Credentials.
    --source      Path to the root directory containing all the source code.
    --port        Port to connect to for WebSocket communication.
    --debuggee    The debuggee ID in Google Cloud Platform.
    --logfile     An optional file to append logging output to.
    --loglevel    The minimum severity to be logged. Must be one of:
                  'error', 'warn', 'info', 'verbose', 'debug', 'silly'.

  Examples
    $ cloud-debug-nodejs-devtools --port=9229 \\
    >   --keyfile=~/keys/my-cloud-project-31415926-a6512b47d6a0.json \\
    >   --source=~/projects/awesome_google_cloud_app
    >   --debuggee=gcp:51384539673:e75dfe61457b23bc
    >   --logfile=~/stackdriver.log --loglevel=info

    $ cloud-debug-nodejs-devtools --default --port=9229 \\
    >   --debuggee=gcp:51384539673:e75dfe61457b23bc
`,
    {
      flags: {
        keyfile: {type: 'string'},
        project: {type: 'string'},
        default: {type: 'boolean'},
        source: {type: 'string'},
        port: {type: 'string'},
        debuggee: {type: 'string'},
        logfile: {type: 'string'},
        loglevel: {type: 'string'},
      },
    });

function validatePort(portString: string): boolean {
  if (!portString || !portString.trim()) {
    return false;
  }
  const portNumber = Number(portString.trim());
  return !isNaN(portNumber) && Number.isInteger(portNumber) &&
      portNumber >= MINIMUM_PORT && portNumber <= MAXIMUM_PORT;
}

async function main(logger: winston.Logger) {
  updateNotifier({pkg}).notify();

  let portNumber: number;
  let sourceDirectory: string;

  if ((cli.flags.keyfile && cli.flags.project) ||
      cli.flags.default && (cli.flags.keyfile || cli.flags.project)) {
    logger.error({
      origin: 'devtools-main',
      message: 'You can specify at most one of keyfile, project, and default.',
    });
    process.exit(1);
  }

  if (cli.flags.source) {
    sourceDirectory = cli.flags.source;
  } else {
    const answers = await inquirer.prompt({
      type: 'input',
      name: 'source',
      message: 'Path to root source directory:',
      default: cli.flags.source || DEFAULT_SOURCE_DIRECTORY,
      validate: (source: string): true | string => {
        if (source.trim()) {
          return true;
        } else {
          return 'Please enter a valid path.';
        }
      },
    } as inquirer.Question);
    sourceDirectory = answers.source.trim();
  }

  logger.info({
    origin: 'devtools-main',
    message: 'Initializing Stackdriver Debugger proxy...',
  });
  const debugProxy =
      new stackdriver.DebugProxy({debuggerId: uuidv4(), sourceDirectory});

  // TODO: Determine keyfiles from project ID
  if (cli.flags.default) {
    await debugProxy.setProjectByKeyFile();
  } else if (cli.flags.keyfile) {
    await debugProxy.setProjectByKeyFile(cli.flags.keyfile);
  } else {
    const answers = await inquirer.prompt({
      type: 'input',
      name: 'keyfile',
      message: 'Path to JSON keyfile (leave blank for default):',
    } as inquirer.Question);
    logger.info({
      origin: 'devtools-main',
      message: answers.keyfile.trim() ?
          `Using ${answers.keyfile.trim()}...` :
          `Using ${process.env.GOOGLE_APPLICATION_CREDENTIALS}...`,
    });
    await debugProxy.setProjectByKeyFile(answers.keyfile.trim());
  }

  if (validatePort(cli.flags.port)) {
    portNumber = Number(cli.flags.port);  // Validated by `validatePort`.
  } else {
    const answers = await inquirer.prompt({
      type: 'input',
      name: 'port',
      message: 'Port for WebSocket communication:',
      default: DEFAULT_PORT,
      validate: (portString: string): true | string => {
        if (validatePort(portString)) {
          return true;
        } else {
          return 'Please enter a valid port number, between ' +
              `${MINIMUM_PORT} and ${MAXIMUM_PORT} inclusive.`;
        }
      },
    } as inquirer.Question);
    portNumber = Number(answers.port);  // Validated by `validatePort`.
  }

  logger.info({
    origin: 'devtools-main',
    message: `Retrieving debuggees for project ${debugProxy.getProjectId()}...`,
  });

  const debuggeesList = await debugProxy.getDebuggees();
  if (debuggeesList.length === 0) {
    logger.error({
      origin: 'devtools-debuggees',
      message: `The project ${debugProxy.getProjectId()} has no debuggees.`,
    });
    process.exit(0);
  }

  // Set the debuggee using the given `cli.flags.debuggee` if possible.
  if (debuggeesList.some(
          (debuggee: stackdriver.Debuggee) =>
              debuggee.id === cli.flags.debuggee)) {
    debugProxy.setDebuggeeId(cli.flags.debuggee);
  } else {
    if (cli.flags.debuggee) {
      logger.error({
        origin: 'devtools-debuggees',
        message: `The given debuggee ${cli.flags.debuggee} was not found.`,
      });
    }
    const answers = await inquirer.prompt({
      type: 'list',
      name: 'debuggee',
      message: 'Select a debuggee:',
      choices: debuggeesList.map(
          (debuggee: stackdriver.Debuggee) => ({
            name: `${debuggee.labels.projectid}, ${debuggee.labels.version}`,
            value: debuggee.id,
          })),
    } as inquirer.Question);
    logger.info({
      origin: 'devtools-main',
      message: `Using debuggee with id: ${answers.debuggee.trim()}`,
    });
    debugProxy.setDebuggeeId(answers.debuggee.trim());
  }

  const adapter = new Adapter(debugProxy);
  const server = serveHttp(portNumber);
  serveWebSocket(server, adapter);
}

if (require.main === module) {
  setupLogger(
      cli.flags.loglevel || DEFAULT_LOGLEVEL,
      cli.flags.logfile || DEFAULT_LOGFILE, true);
  // TODO: get() does not exist yet, will be resolved in Winston 3.1
  // https://github.com/winstonjs/winston/issues/1361
  // tslint:disable-next-line no-any
  const logger = (winston.loggers as any).get('devtools-logger');
  process.on('uncaughtException', (error) => {
    logger.error({origin: 'devtools-exception', message: error.stack});
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    logger.error({origin: 'devtools-rejection', message: error.stack});
    process.exit(1);
  });
  main(logger).catch(
      (error) =>
          logger.error({origin: 'devtools-error', message: error.stack}));
}
