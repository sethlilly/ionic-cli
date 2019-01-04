import {
  CommandLineInputs,
  CommandLineOptions,
  LOGGER_LEVELS,
  OptionGroup,
  contains,
  validators
} from '@ionic/cli-framework';
import { columnar } from '@ionic/cli-framework/utils/format';
import { sleep } from '@ionic/cli-framework/utils/process';
import chalk from 'chalk';
import * as Debug from 'debug';
import * as fs from 'fs';
import * as https from 'https';

import { CommandMetadata } from '../../definitions';
import { isSuperAgentError } from '../../guards';
import { Command } from '../../lib/command';
import { FatalException } from '../../lib/errors';
import { fileUtils } from '../../lib/utils/file';

const debug = Debug('ionic:commands:package:build');
const PLATFORMS = ['android', 'ios'];
const ANDROID_BUILD_TYPES = ['debug', 'release'];
const IOS_BUILD_TYPES = ['development', 'ad-hoc', 'app-store', 'enterprise'];
const BUILD_TYPES = ANDROID_BUILD_TYPES.concat(IOS_BUILD_TYPES);

interface PackageBuild {
  job_id: number;
  id: string;
  caller_id: number;
  platform: string;
  build_type: string;
  created: string;
  finished: string;
  state: string;
  commit: any;
  stack: any;
  profile_tag: string;
  automation_id: number;
  environment_id: number;
  native_config_id: number;
  automation_name: string;
  environment_name: string;
  native_config_name: string;
  job: any;
}

interface DownloadUrl {
  url: string | null;
}

export class BuildCommand extends Command {
  async getMetadata(): Promise<CommandMetadata> {
    return {
      name: 'build',
      type: 'project',
      summary: 'Create a package build on Appflow.',
      description: `
Creates a package build on Appflow using named Appflow parameters, then tails the build log from Appflow and
finally downloads the created app package file in the current directory if the build is successful.

The basic commands can be customized with a combination of Options and Advanced Options.

Apart from the ${chalk.green('--commit')} option, all the others options can be specified using the verbose name you selected upon setup in the Appflow Dashboard.

The ${chalk.green('--security-profile')} option is mandatory for any iOS build while is not required from an android debug build.

Other notes:
${chalk.green('--environment')} allows to specify the name of an environment to customize the build
${chalk.green('--native-config')} allows to specify the name of a native config set of parameters to override the default specified in the app
${chalk.green('--target-platform')} allows to override the preferred platform with another one: this is currently useful only for building older iOS apps instead of the preferred iOS 10 used by default
${chalk.green('--build-file-name')} allows to specify a custon name for the build package file that will be downloaded; it can only be a file name and not a path
`,
      exampleCommands: [
        'android debug',
        'ios development --security-profile="iOS Security Profile Name"',
        'android debug --environment="My Custom Environment Name"',
        'android debug --native-config="My Custom Native Config Name"',
        'android debug --commit=2345cd3305a1cf94de34e93b73a932f25baac77c',
        'ios development --security-profile="iOS Security Profile Name" --target-platform="iOS - Xcode 9"',
        'ios development --security-profile="iOS Security Profile Name" --build-file-name=my_custom_file_name.ipa',
      ],
      inputs: [
        {
          name: 'platform',
          summary: `The platform to package (${PLATFORMS.map(v => chalk.green(v)).join(', ')})`,
          validators: [validators.required, contains(PLATFORMS, {})],
        },
        {
          name: 'type',
          summary: `The build type (${BUILD_TYPES.map(v => chalk.green(v)).join(', ')})`,
          validators: [validators.required, contains(BUILD_TYPES, {})],
        },
      ],
      options: [
        {
          name: 'security-profile',
          summary: 'Security profile',
          type: String,
          spec: { value: 'name' },
        },
        {
          name: 'environment',
          summary: 'The group of environment variables exposed to your build',
          type: String,
          spec: { value: 'name' },
        },
        {
          name: 'native-config',
          summary: 'The group of native config variables exposed to your build',
          type: String,
          spec: { value: 'name' },
        },
        {
          name: 'commit',
          summary: 'Commit (defaults to HEAD)',
          type: String,
          groups: [OptionGroup.Advanced],
          spec: { value: 'sha1' },
        },
        {
          name: 'target-platform',
          summary: 'Target platform',
          type: String,
          groups: [OptionGroup.Advanced],
          spec: { value: 'name' },
        },
        {
          name: 'build-file-name',
          summary: 'The name for the downloaded build file',
          type: String,
          groups: [OptionGroup.Advanced],
          spec: { value: 'name' },
        },
      ],
    };
  }

  async preRun(inputs: CommandLineInputs, options: CommandLineOptions): Promise<void> {
    if (!inputs[0]) {
      const platformInput = await this.env.prompt({
        type: 'list',
        name: 'platform',
        choices: PLATFORMS,
        message: `Platform to package:`,
        validate: v => validators.required(v) && contains(PLATFORMS, {})(v),
      });

      inputs[0] = platformInput;
    }

    const buildTypes = inputs[0] === 'ios' ? IOS_BUILD_TYPES : ANDROID_BUILD_TYPES;

    // validate that the build type is valid for the platform
    let reenterBuilType = false;
    if (inputs[1] && !buildTypes.includes(inputs[1])) {
      reenterBuilType = true;
      this.env.log.warn(`Build type ${chalk.bold(inputs[1])} incompatible for ${chalk.bold(inputs[0])}; please choose a correct one`);
      this.env.log.nl();
    }

    if (!inputs[1] || reenterBuilType) {
      const typeInput = await this.env.prompt({
        type: 'list',
        name: 'type',
        choices: buildTypes,
        message: `Build type:`,
        validate: v => validators.required(v) && contains(buildTypes, {})(v),
      });

      inputs[1] = typeInput;
    }

    // the security profile is mandatory for iOS packages, so prompting if it is missing
    if (inputs[0] === 'ios' && !options['security-profile']) {
      if (this.env.flags.interactive) {
        this.env.log.warn(`A security profile is mandatory to build an iOS package`);
        this.env.log.nl();
      }

      const securityProfileOption = await this.env.prompt({
        type: 'input',
        name: 'security-profile',
        message: `Security Profile Name:`,
      });

      options['security-profile'] = securityProfileOption;
    }
  }

  async run(inputs: CommandLineInputs, options: CommandLineOptions): Promise<void> {
    if (!this.project) {
      throw new FatalException(`Cannot run ${chalk.green('ionic package build')} outside a project directory.`);
    }

    const token = this.env.session.getUserToken();
    const appflowId = await this.project.requireAppflowId();
    const [ platform, buildType ] = inputs;

    if (!options.commit) {
      options.commit = (await this.env.shell.output('git', ['rev-parse', 'HEAD'], { cwd: this.project.directory })).trim();
      debug(`Commit hash: ${chalk.bold(options.commit)}`);
    }

    let build = await this.createPackageBuild(appflowId, token, platform, buildType, options);
    const buildId = build.job_id;

    let customBuildFileName = '';
    if (options['build-file-name']) {
      if (typeof (options['build-file-name']) !== 'string' || !fileUtils.isValidFileName(options['build-file-name'])) {
        throw new FatalException(`${chalk.bold(String(options['build-file-name']))} is not a valid file name`);
      }
      customBuildFileName = String(options['build-file-name']);
    }

    const details = columnar([
      ['Appflow ID', chalk.bold(appflowId)],
      ['Build ID', chalk.bold(buildId.toString())],
      ['Commit', chalk.bold(`${build.commit.sha.substring(0, 6)} ${build.commit.note}`)],
      ['Target Platform', chalk.bold(build.stack.friendly_name)],
      ['Build Type', chalk.bold(build.build_type)],
      ['Security Profile', build.profile_tag ? chalk.bold(build.profile_tag) : chalk.dim('not set')],
      ['Environment', build.environment_name ? chalk.bold(build.environment_name) : chalk.dim('not set')],
      ['Native Config', build.native_config_name ? chalk.bold(build.native_config_name) : chalk.dim('not set')],
    ], { vsep: ':' });

    this.env.log.ok(
      `Build created\n` +
      details + '\n\n'
    );

    build = await this.tailBuildLog(appflowId, buildId, token);
    if (build.state !== 'success') {
      throw new Error('Build failed');
    }

    const url = await this.getDownloadUrl(appflowId, buildId, token);
    if (!url.url) {
      throw new Error('Missing URL in response');
    }

    const filename = await this.downloadBuild(url.url, customBuildFileName);
    this.env.log.ok(`Build completed: ${filename}`);
  }

  async createPackageBuild(appflowId: string, token: string, platform: string, buildType: string, options: CommandLineOptions): Promise<PackageBuild> {
    const { req } = await this.env.client.make('POST', `/apps/${appflowId}/packages/verbose_post`);
    req.set('Authorization', `Bearer ${token}`).send({
      platform,
      build_type: buildType,
      commit_sha: options.commit,
      stack_name: options['target-platform'],
      profile_name: options['security-profile'],
      environment_name: options.environment,
      native_config_name: options['native-config'],
    });

    try {
      const res = await this.env.client.do(req);
      return res.data as PackageBuild;
    } catch (e) {
      if (isSuperAgentError(e)) {
        this.env.log.error(`Unable to create build: ` + e.message);
        if (e.response.status === 401) {
          this.env.log.error('Try logging out and back in again.');
        }
      }
      throw e;
    }
  }

  async getPackageBuild(appflowId: string, buildId: number, token: string): Promise<PackageBuild> {
    const { req } = await this.env.client.make('GET', `/apps/${appflowId}/packages/${buildId}`);
    req.set('Authorization', `Bearer ${token}`).send();

    try {
      const res = await this.env.client.do(req);
      return res.data as PackageBuild;
    } catch (e) {
      if (isSuperAgentError(e)) {
        this.env.log.error(`Unable to get build ${buildId}: ` + e.message);
        if (e.response.status === 401) {
          this.env.log.error('Try logging out and back in again.');
        }
      }
      throw e;
    }
  }

  async getDownloadUrl(appflowId: string, buildId: number, token: string): Promise<DownloadUrl> {
    const { req } = await this.env.client.make('GET', `/apps/${appflowId}/packages/${buildId}/download`);
    req.set('Authorization', `Bearer ${token}`).send();

    try {
      const res = await this.env.client.do(req);
      return res.data as DownloadUrl;
    } catch (e) {
      if (isSuperAgentError(e)) {
        this.env.log.error(`Unable to get download URL for build ${buildId}: ` + e.message);
        if (e.response.status === 401) {
          this.env.log.error('Try logging out and back in again.');
        }
      }
      throw e;
    }
  }

  async tailBuildLog(appflowId: string, buildId: number, token: string): Promise<PackageBuild> {
    let build;
    let start = 0;
    const ws = this.env.log.createWriteStream(LOGGER_LEVELS.INFO, false);

    let isCreatedMessage = false;
    while (!(build && (build.state === 'success' || build.state === 'failed'))) {
      await sleep(5000);
      build = await this.getPackageBuild(appflowId, buildId, token);
      if (build && build.state === 'created' && !isCreatedMessage) {
        ws.write(chalk.yellow('Concurrency limit reached: build will start as soon as other builds finish.'));
        isCreatedMessage = true;
      }
      const trace = build.job.trace;
      if (trace.length > start) {
        ws.write(trace.substring(start));
        start = trace.length;
      }
    }
    ws.end();

    return build;
  }

  async downloadBuild(url: string, customBuildFileName: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      https.get(url, res => {
        const contentDisposition = res.headers['content-disposition'];
        let filename = contentDisposition ? contentDisposition.split('=')[1] : 'output.bin';
        if (customBuildFileName) {
          filename = customBuildFileName;
        }
        const ws = fs.createWriteStream(filename);
        ws.on('error', reject);
        ws.on('finish', () => resolve(filename));
        res.pipe(ws);
      }).on('error', reject);
    });
  }
}