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
import * as winston from 'winston';
import * as TransportStream from 'winston-transport';

export function setupLogger(level: string, logfile: string, console: boolean) {
  const winstonFormatPrintf = winston.format.printf((info) => {
    const time = info.timestamp.substring(0, 19).replace('T', ' ');
    return `${time} [${info.origin}, ${info.level}] ${info.message}`;
  });

  const transports: TransportStream[] = [];

  if (console) {
    transports.push(new winston.transports.Console({
      format: winston.format.combine(
          winston.format.colorize(), winston.format.timestamp(),
          winstonFormatPrintf),
    }));
  }

  if (logfile) {
    transports.push(new winston.transports.File({
      filename: logfile,
      format: winston.format.combine(
          winston.format.timestamp(), winstonFormatPrintf),
    }));
  }

  // TODO: add() does not exist yet, will be resolved in Winston 3.1
  // https://github.com/winstonjs/winston/issues/1361
  // tslint:disable-next-line no-any
  (winston.loggers as any).add('devtools-logger', {level, transports});
}
