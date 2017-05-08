import Argument from './argument';
import Arguments from './arguments';
import Command from './command';
import HookEmitter from 'hook-emitter';
import Option from './option';
import snooplogg from 'snooplogg';

const log = snooplogg.config({ theme: 'detailed' })('cli-kit:context').log;

const optRE = /^(?:--|—)(?:([^=]+)(?:=([\s\S]*))?)?$/;
const dashOpt = /^(?:-|—)(.+)$/;
const negateRegExp = /^no-(.+)$/;

function camelCase(s) {
	return s.replace(/(?:^\w|[A-Z]|\b\w)/g, (m, i) => i ? m.toUpperCase() : m.toLowerCase()).replace(/[^\w]+/g, '');
}

/**
 * Defines a context for commands, options, and args.
 *
 * @extends {HookEmitter}
 */
export default class Context extends HookEmitter {
	/**
	 * Constructs a context instance.
	 *
	 * @param {Object} [opts] - Various options.
	 * @param {Array<Object>} [opts.args] - An array of arguments.
	 * @param {Boolean} [opts.camelCase=true] - Camel case option names.
	 * @param {Object} [opts.commands] - A map of command names to command
	 * descriptors.
	 * @param {Array<Object>|Object} [opts.options] - An array of options.
	 * @param {Context} [opts.parent] - Parent context.
	 * @param {String} [opts.title] - Context title.
	 * @access public
	 */
	constructor(opts={}) {
		if (opts.args && !Array.isArray(opts.args)) {
			throw new TypeError('Expected args to be an array');
		}

		if (opts.commands && (typeof opts.commands !== 'object' || Array.isArray(opts.commands))) {
			throw new TypeError('Expected commands to be an object');
		}

		if (opts.options && typeof opts.options !== 'object') {
			throw new TypeError('Expected options to be an object or an array');
		}

		super();

		Object.assign(this, opts);

		this.args      = [];
		this.commands  = {};
		this.options   = [];
		this.groups    = {};

		// initialize the alias lookup tables
		this.lookup = {
			commands: {},
			long:     {},
			short:    {},
			toString: () => {
				return 'Context Lookup:\n' +
					(Object.keys(this.lookup.commands).length ? `  Commands:\n${Object.keys(this.lookup.commands).map(c => `    ${c} => ${this.lookup.commands[c].name}`).join('\n')}\n` : '') +
					(Object.keys(this.lookup.long).length || Object.keys(this.lookup.short).length ?
						( '  Options:\n' +
							Object.keys(this.lookup.long).map(s => `    --${s} => ${this.lookup.long[s].name}`).join('\n') + '\n' +
							Object.keys(this.lookup.short).map(s => `    -${s} => ${this.lookup.short[s].name}`).join('\n')
						) : '');
			}
		};

		this.camelCase = opts.camelCase !== false;

		// initialize the commands
		if (opts.commands) {
			for (const name of Object.keys(opts.commands)) {
				this.command(name, opts.commands[name]);
			}
		}

		// initialize the options
		if (Array.isArray(opts.options)) {
			let group = null;
			for (const groupOrOption of opts.options) {
				if (!groupOrOption || (typeof groupOrOption !== 'string' && typeof groupOrOption !== 'object') || Array.isArray(groupOrOption)) {
					throw new TypeError('Expected options array element to be a string or an object');
				}
				if (typeof groupOrOption === 'string') {
					group = groupOrOption;
				} else {
					for (const format of Object.keys(groupOrOption)) {
						this.option(format, group, groupOrOption[format]);
					}
				}
			}
		} else if (opts.options) {
			for (const format of Object.keys(opts.options)) {
				this.option(format, opts.options[format]);
			}
		}

		if (Array.isArray(opts.args)) {
			for (const arg of opts.args) {
				this.argument(arg);
			}
		}
	}

	argument(arg={}) {
		this.args.push(arg instanceof Argument ? arg : new Argument(arg));
	}

	command(name, opts) {
		if (name && typeof name === 'object' && !Array.isArray(name) && name.name) {
			opts = name;
			name = opts.name;
		}

		if (!name || typeof name !== 'string') {
			throw new TypeError('Expected name to be a non-empty string');
		}

		if (typeof opts === 'function') {
			opts = {
				action: opts
			};
		} else if (!opts) {
			opts = {};
		}

		if (typeof opts !== 'object' || Array.isArray(opts)) {
			throw new TypeError('Expected argument to be an object');
		}

		opts.parent = this;

		log(`Adding command: ${name}`);

		const cmd = new Command(name, opts);
		this.commands[name] = cmd;

		this.lookup.commands[name] = cmd;
		if (cmd.aliases) {
			for (const alias of Object.keys(cmd.aliases)) {
				if (!this.commands[alias]) {
					this.lookup.commands[alias] = cmd;
				}
			}
		}

		return this;
	}

	option(format, group, params) {
		if (group && typeof group === 'object') {
			params = group;
			group = null;
		}

		const opt = new Option(format, params);
		this.options.push(opt);

		this.groups[group || ''] = opt;

		if (opt.long) {
			this.lookup.long[opt.long] = opt;
		}

		if (opt.short) {
			this.lookup.short[opt.short] = opt;
		}

		let alias;
		for (alias of Object.keys(opt.aliases.long)) {
			this.lookup.long[alias] = opt;
		}

		for (alias of Object.keys(opt.aliases.short)) {
			this.lookup.short[alias] = opt;
		}

		return this;
	}

	parse($args) {
		if (!($args instanceof Arguments)) {
			$args = new Arguments($args);
			$args.contexts.push(this);
		}

		const command = $args.contexts[0];

		log(this.lookup.toString());

		// the parse arg hook
		const parseArg = this.hook('parseArg', ($args, ctx, arg, i, args) => {
			// if we have an unknown option, then we need to reconstruct it to
			// make our regexes below work
			if (arg && arg.type === 'unknown option') {
				arg = '--' + arg.name;

			// arg is null, empty, or already processed, so skip it
			} else if (!arg || typeof arg === 'object') {
				return $args;
			}

			log('Parsing argument:', arg);

			let m = arg.match(optRE);

			// check if `--`
			if (m && !m[1]) {
				args[i] = { type: 'extra', value: args.slice(i + 1) };
				args.fill(null, i + 1);
				return $args;
			}

			// check if long option
			if (m) {
				// --something or --something=foo
				const negated = m[1].match(negateRegExp);
				const name = negated ? negated[1] : m[1];
				const option = this.lookup.long[name];
				if (option) {
					log(`Found option: ${option.name}`);

					if (m[2]) {
						// --something=foo
						args[i] = { type: 'option', option, value: option.transform(m[2]) };
						return $args;
					}

					// if value is `null`, then we are missing the value
					let value = null;

					if (option.type === 'bool') {
						value = !negated;
					} else if (i + 1 < args.length) {
						value = option.transform(args[i + 1]);
						args[i + 1] = null;
					}

					args[i] = { type: 'option', option, value };
					return $args;
				}

				// treat unknown options as flags
				args[i] = { type: 'unknown option', name: m[1] };
				return $args;
			}

			// check if short option
			if (m = arg.match(dashOpt)) {
				// -x

				// const option = this.lookup.short[m[1]];
				// if (option) {
				// 	log(`Found option: ${option.name}`);
				//
				// 	if (m[2]) {
				// 		// --x=foo
				// 		args[i] = { type: 'option', option, value: option.transform(m[2]) };
				// 		return $args;
				// 	}
				//
				// 	// if value is `null`, then we are missing the value
				// 	let value = null;
				//
				// 	if (option.type === 'bool') {
				// 		value = true;
				// 	} else if (i + 1 < args.length) {
				// 		value = option.transform(args[i + 1]);
				// 		args[i + 1] = null;
				// 	}
				//
				// 	args[i] = { type: 'option', option, value };
				// 	return $args;
				// }

				args[i] = { type: 'unknown option', name: m[1] };
				return $args;
			}

			// check if command
			const cmd = this.lookup.commands[arg];
			if (cmd) {
				log(`Found command: ${cmd.name}`);
				args[i] = { type: 'command', command: cmd };
				$args.contexts.unshift(cmd);
				return $args;
			}

			return $args;
		});

		return this.hook('parse', $args => {
			log('Parsing:', $args.args);
			return $args.args
				.reduce((promise, arg, i, args) => {
					return promise
						.then($args => parseArg($args, this, arg, i, args))
						.then($a => $a || $args);
				}, Promise.resolve($args))
				.then($args => $args.prune())
				.then($args => {
					const cmd = $args.contexts[0];

					if (cmd && cmd !== command) {
						log('Descending into next context\'s parser');
						cmd.link(this);
						return cmd.parse($args);
					}

					log('Finalizing parsing');

					const env = {};

					// loop over each context and gather the option defaults and
					// environment variable valuedefault options
					log(`Processing default options and environment variables for ${$args.contexts.length} contexts`);
					for (let i = $args.contexts.length; i; i--) {
						for (const option of $args.contexts[i-1].options) {
							if (option.name) {
								const name = option.camelCase === false || !this.camelCase ? option.name : camelCase(option.name);
								if (option.default !== undefined) {
									$args.argv[name] = option.default;
								} else if (option.type === 'bool') {
									$args.argv[name] = !!option.negate;
								}
								if (option.env && process.env[option.env] !== undefined) {
									env[name] = option.transform(process.env[option.env]);
								}
							}
						}
					}

					// fill argv and _
					log('Filling argv and _');
					let i = 0;
					for (const arg of $args.args) {
						if (typeof arg === 'object') {
							switch (arg.type) {
								case 'option':
									$args.argv[arg.option.camelCase === false || !this.camelCase ? arg.option.name : camelCase(arg.option.name)] = arg.value;
									break;
								case 'unknown option':
									$args.argv[this.camelCase ? camelCase(arg.name) : arg.name] = true;
									break;
							}
						} else {
							if (this.args[i]) {
								$args._.push(this.args[i].transform(arg));
							} else {
								$args._.push(arg);
							}
							i++;
						}
					}

					// process env vars
					log('Mixing in environment variable values');
					Object.assign($args.argv, env);

					return $args;
				});
		})($args);
	}
}