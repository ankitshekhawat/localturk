#!/usr/bin/env node

/**
 * "Local Turk" server for running Mechanical Turk-like tasks locally.
 *
 * Usage:
 *
 *   localturk [--options] template.html tasks.csv outputs.csv
 */

import * as bodyParser from 'body-parser';
import * as errorhandler from 'errorhandler';
import * as express from 'express';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as program from 'commander';
import open = require('open');
import * as _ from 'lodash';

import * as csv from './csv';
import { makeTemplate } from './sample-template';
import * as utils from './utils';
import { outputFile } from 'fs-extra';

import * as shuffleArray from 'shuffle-array';
program
  .version('2.0.3')
  .usage('[options] template.html tasks.csv outputs.csv')
  .option('-p, --port <n>', 'Run on this port (default 4321)', parseInt)
  .option('-s, --static-dir <dir>',
  'Serve static content from this directory. Default is same directory as template file.')
  .option('-w, --write-template', 'Generate a stub template file based on the input CSV.')
  .parse(process.argv);

const { args, writeTemplate } = program;
if (!((3 === args.length && !writeTemplate) ||
  (1 === args.length && writeTemplate))) {
  program.help();
}
if (writeTemplate) {
  // tasks.csv is the only input with --write-template.
  args.unshift('');
  args.push('');
}

const [templateFile, tasksFile, outputsFile] = args;
const port = program.port || 4321;
// --static-dir is particularly useful for classify-images, where the template file is in a
// temporary directory but the image files could be anywhere.
const staticDir = program['staticDir'] || path.dirname(templateFile);

type Task = { [key: string]: string };
let flash = '';  // this is used to show warnings in the web UI.

async function renderTemplate({ task, numCompleted, numTotal }: TaskStats, uid: String) {
  const template = await fs.readFile(templateFile, { encoding: 'utf8' });
  const fullDict = {};
  for (const k in task) {
    fullDict[k] = utils.htmlEntities(task[k]);
  }
  // Note: these two fields are not available in mechanical turk.
  fullDict['ALL_JSON'] = utils.htmlEntities(JSON.stringify(task, null, 2));
  fullDict['ALL_JSON_RAW'] = JSON.stringify(task);
  const userHtml = utils.renderTemplate(template, fullDict);

  const thisFlash = flash;
  flash = '';
  const sourceInputs = _.map(task, (v, k) =>
    `<input type=hidden name="${k}" value="${utils.htmlEntities(v)}">`
  ).join('\n');

  return utils.dedent`
    <!doctype html>
    <html>
    <title>${numCompleted} / ${numTotal} - localturk</title>
    <body><form action=/submit method=post>
    <nav>
    <div class="nav-wrapper">
      <span class="brand-logo center">${numCompleted} / ${numTotal}</span>
      <ul class="right hide-on-med-and-down">
      <li><i class="material-icons left">account_circle</i>${uid}</li>
      <li><a href="/"><i class="material-icons right">close</i></a></li>
    </ul>
    </div>
  </nav>
    <div class="container">
    <p><span style="background: yellow">${thisFlash}</span></div>    
    ${sourceInputs}
    ${userHtml}
    <hr/>
    <input type="hidden" name="uid" value="${uid}"/>
    <div class="container"><input class="waves-effect waves-light btn" type=submit value="submit" />  </div>
    </form>
    <script>
    // Support keyboard shortcuts via, e.g. <.. data-key="1" />
    window.addEventListener("keydown", function(e) {
      if (document.activeElement !== document.body) return;
      var key = e.key;
      const el = document.querySelector('[data-key="' + key + '"]');
      if (el) {
        e.preventDefault();
        el.click();
      }
    });
    </script>
    </body>
    </html>
  `;
}

async function readCompletedTasks(): Promise<Task[]> {
  if (!fs.pathExistsSync(outputsFile)) return [];
  return csv.readAllRowObjects(outputsFile);
}

function isTaskCompleted(task, completedTasks) {
  const normTask = utils.normalizeValues(task);
  for (const d of completedTasks) {
    if (utils.isSupersetOf(d, normTask)) return true;
  }
  return false;
}

async function checkTaskOutput(task: Task) {
  // Check whether the output has any keys that aren't in the input.
  // This is a common mistake that can happen if you forget to set a name on
  // your form elements.
  const headers = await csv.readHeaders(tasksFile);
  for (const k in task) {
    if (headers.indexOf(k) === -1) return;  // there's a new key.
  }
  flash = 'No new keys in output. Make sure your &lt;input&gt; elements have "name" attributes';
}

interface TaskStats {
  task?: Task;
  numCompleted: number;
  numTotal: number;
}

async function getNextTask(): Promise<TaskStats> {
  const completedTasks = (await readCompletedTasks()).map(utils.normalizeValues);
  let nextTask: Task;
  let numTotal = 0;
  let taskList: Task[] = [];
  for await (const task of csv.readRowObjects(tasksFile)) {
    taskList.push(task);
  }
  for await (const task of shuffleArray(taskList)) {
    numTotal++;
    if (!nextTask && !isTaskCompleted(utils.normalizeValues(task), completedTasks)) {
      nextTask = task;
    }
  }

  return {
    task: nextTask,
    numCompleted: _.size(completedTasks),
    numTotal,
  }
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(errorhandler());
app.use(express.static(path.resolve(staticDir)));

app.get('/task', utils.wrapPromise(async (req, res) => {
  let uid = req.query.uid;
  if (typeof uid === 'undefined' || !uid || uid === '') { res.send('No User ID <a href="/">Go to login screen</a>') };
  console.log(uid);
  const nextTask = await getNextTask();
  if (nextTask.task) {
    console.log(nextTask.task);
    const html = await renderTemplate(nextTask, uid);
    res.send(html);
  } else {
    res.send('DONE');
    process.exit(0);
  }
}));

app.get('/', utils.wrapPromise(async (req, res) => {
  const msg = req.query.msg;
  let html = await fs.readFile("login.html", { encoding: 'utf8' });
  let message = '';
  if (msg === 'invalidId') { message = 'Invalid id, try again!'; }
  html = html.replace(/\$\{([message^}]*)\}/g, message);
  res.send(html);
}));

app.post('/submit', utils.wrapPromise(async (req, res) => {
  const task: Task = req.body;
  await csv.appendRow(outputsFile, task);
  checkTaskOutput(task);  // sets the "flash" variable with any errors.
  console.log('Saved ' + JSON.stringify(task));
  res.redirect('/task?uid=' + req.body.uid);
}));

app.post('/login-form', utils.wrapPromise(async (req, res) => {
  for await (const user of csv.readRowObjects('meta/user_db.csv')) {
    if (req.body.uid.toLowerCase() === user.uid.toLowerCase()) { res.redirect('/task?uid=' + req.body.uid); }
  }
  res.redirect('/?msg=invalidId')
  // res.send('Invalid id, try again <a href="/">Go to login screen</a>');
}));

app.post('/delete-last', utils.wrapPromise(async (req, res) => {
  const row = await csv.deleteLastRow(outputsFile);
  console.log('Deleting', row);
  res.redirect('/');
}));


if (writeTemplate) {
  (async () => {
    const columns = await csv.readHeaders(tasksFile);
    console.log(makeTemplate(columns));
  })().catch(e => {
    console.error(e);
  });
} else {
  app.listen(port);
  const url = `http://localhost:${port}`;
  console.log('Running local turk on', url);
  open(url);
}
