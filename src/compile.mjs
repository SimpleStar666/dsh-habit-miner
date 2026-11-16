/**
 * Local author-DSL → JSON Schema compiler.
 *
 * Why this exists: the host's `ctx.tools.register()` accepts a *compiled* tool
 * definition and does **not** validate `parameters` — and `ctx.tools.defineTool` is
 * not exposed on the service (only the module-level `defineTool` from
 * `@deepseek-ai/dsh-tools` is, which a profile-installed plugin cannot resolve).
 *
 * Registering the author DSL directly therefore ships a `parameters` object that is
 * not a JSON Schema (`{id: {type:'string', required:true}}` instead of
 * `{type:'object', properties:{…}, required:['id']}`), and the model provider rejects
 * the whole request:
 *
 *   Invalid schema for function 'persona_forget': "" is not valid under any of the
 *   schemas listed in the 'anyOf' keyword
 *
 * So we compile locally, mirroring the host's own semantics for the subset this
 * plugin uses: scalar/object/array/json nodes, annotations, `required: true` on a
 * property, `enum`/`const`, and explicit `additionalProperties`.
 *
 * @module dsh-habit-miner/compile
 */

/** Keys allowed on any author node. */
const ANNOTATIONS = ['description', 'title', 'default', 'examples'];

/** Scalar node types the DSL understands. */
const SCALARS = ['string', 'number', 'integer', 'boolean', 'null'];

/**
 * Throw a readable error for an unsupported author node.
 *
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(`dsh-habit-miner: tool schema ${message}`);
}

/**
 * Is this a plain object (not array/null)?
 *
 * @param {any} value
 * @returns {boolean}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Compile one property map (the implicit `parameters` object).
 *
 * @param {object} spec
 * @param {string} path
 * @returns {{type: 'object', properties: object, required?: string[]}}
 */
function compilePropertyMap(spec, path) {
  if (!isRecord(spec)) fail(`${path} must be an object of value schemas`);
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec)) {
    if (!isRecord(value)) fail(`${path}.${key} must be a value schema object`);
    if (Object.hasOwn(value, 'required') && value.required !== true) {
      fail(`${path}.${key}.required must be true when present`);
    }
    if (value.required === true) required.push(key);
    properties[key] = compileValue(value, `${path}.${key}`, { allowRequired: true });
  }
  return required.length ? { type: 'object', properties, required } : { type: 'object', properties };
}

/**
 * Compile one value schema node.
 *
 * @param {object} spec
 * @param {string} path
 * @param {{allowRequired?: boolean}} [options]
 * @returns {object}
 */
function compileValue(spec, path, options = {}) {
  if (!isRecord(spec)) fail(`${path} must be a value schema object`);
  const allowed = [...ANNOTATIONS, ...(options.allowRequired ? ['required'] : [])];

  if (Object.hasOwn(spec, 'oneOf')) {
    const keys = [...allowed, 'oneOf'];
    for (const key of Object.keys(spec)) {
      if (!keys.includes(key)) fail(`${path}.${key} is not supported here`);
    }
    if (Object.hasOwn(spec, 'type')) fail(`${path} cannot declare both type and oneOf`);
    if (!Array.isArray(spec.oneOf) || spec.oneOf.length < 2) fail(`${path}.oneOf must be an array of at least two schemas`);
    const node = { oneOf: spec.oneOf.map((branch, index) => compileValue(branch, `${path}.oneOf[${index}]`)) };
    copyAnnotations(spec, node);
    return node;
  }

  const type = spec.type;
  if (!SCALARS.includes(type) && type !== 'object' && type !== 'array' && type !== 'json') {
    fail(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
  }

  const node = {};
  copyAnnotations(spec, node);

  if (type === 'json') {
    for (const key of Object.keys(spec)) {
      if (![...allowed, 'type'].includes(key)) fail(`${path}.${key} is not supported here`);
    }
    return node; // annotation-only: accepts any JSON value
  }

  node.type = type;

  if (type === 'object') {
    for (const key of Object.keys(spec)) {
      if (![...allowed, 'type', 'properties', 'additionalProperties'].includes(key)) {
        fail(`${path}.${key} is not supported here`);
      }
    }
    if (typeof spec.additionalProperties !== 'boolean') {
      fail(`${path}.additionalProperties must be explicitly true or false`);
    }
    node.additionalProperties = spec.additionalProperties;
    if (Object.hasOwn(spec, 'properties')) {
      const compiled = compilePropertyMap(spec.properties, `${path}.properties`);
      node.properties = compiled.properties;
      if (compiled.required) node.required = compiled.required;
    }
    return node;
  }

  if (type === 'array') {
    for (const key of Object.keys(spec)) {
      if (![...allowed, 'type', 'items'].includes(key)) fail(`${path}.${key} is not supported here`);
    }
    if (Object.hasOwn(spec, 'items')) node.items = compileValue(spec.items, `${path}.items`);
    return node;
  }

  // Scalars.
  for (const key of Object.keys(spec)) {
    if (![...allowed, 'type', 'enum', 'const'].includes(key)) fail(`${path}.${key} is not supported here`);
  }
  if (Object.hasOwn(spec, 'enum')) {
    if (!Array.isArray(spec.enum) || spec.enum.length === 0) fail(`${path}.enum must be a non-empty array`);
    node.enum = [...spec.enum];
  }
  if (Object.hasOwn(spec, 'const')) node.const = spec.const;
  return node;
}

/**
 * Copy display annotations from an author node onto a compiled node.
 *
 * @param {object} source
 * @param {object} target
 * @returns {void}
 */
function copyAnnotations(source, target) {
  for (const key of ANNOTATIONS) {
    if (Object.hasOwn(source, key)) target[key] = source[key];
  }
}

/**
 * Compile an implicit parameter map into an object-rooted JSON Schema.
 *
 * @param {object} spec
 * @returns {{type: 'object', properties: object, required?: string[]}}
 */
export function compileParameters(spec) {
  return compilePropertyMap(spec ?? {}, 'parameters');
}

/**
 * Compile an output schema. Output schemas in this plugin are written as raw JSON
 * Schema already, so this validates and normalizes rather than rewrites.
 *
 * @param {object} spec
 * @returns {object}
 */
export function compileOutputSchema(spec) {
  const schema = compileValue(spec, 'output.schema');
  if (schema.type !== 'object') fail('output.schema must be an object root');
  if (typeof schema.additionalProperties !== 'boolean') {
    fail('output.schema.additionalProperties must be explicitly true or false');
  }
  return schema;
}

/**
 * Assert one compiled parameter schema is provider-safe. This is the guard that
 * would have caught the "raw author DSL registered as JSON Schema" bug at startup
 * instead of at the first model call.
 *
 * @param {object} parameters
 * @param {string} name tool name, for the error message
 * @returns {void}
 */
export function assertProviderSafeParameters(parameters, name) {
  if (!isRecord(parameters)) fail(`${name}.parameters must be an object`);
  if (parameters.type !== 'object') fail(`${name}.parameters must be object-rooted (got ${JSON.stringify(parameters.type)})`);
  if (!isRecord(parameters.properties)) fail(`${name}.parameters.properties must be an object`);
  if (Object.hasOwn(parameters, 'required') && !Array.isArray(parameters.required)) {
    fail(`${name}.parameters.required must be an array`);
  }
  for (const [key, property] of Object.entries(parameters.properties)) {
    if (!isRecord(property)) fail(`${name}.parameters.properties.${key} must be a schema object`);
    if (Object.hasOwn(property, 'required')) {
      fail(`${name}.parameters.properties.${key}.required must be hoisted to the parameters.required array`);
    }
    if (typeof property.type !== 'string' && !Array.isArray(property.oneOf)) {
      fail(`${name}.parameters.properties.${key} must declare a type`);
    }
  }
}

/**
 * Compile one author-DSL tool spec into the definition `ctx.tools.register()`
 * expects — the same shape the host's module-level `defineTool` produces.
 *
 * @param {object} spec
 * @returns {object}
 */
export function compileToolDefinition(spec) {
  if (!isRecord(spec)) fail('tool spec must be an object');
  if (typeof spec.name !== 'string' || spec.name.length === 0) fail('tool spec needs a name');
  if (typeof spec.execute !== 'function') fail(`${spec.name}.execute must be a function`);
  if (!isRecord(spec.output) || typeof spec.output.render !== 'function') {
    fail(`${spec.name}.output must declare { schema, render }`);
  }

  const parameters = compileParameters(spec.parameters);
  assertProviderSafeParameters(parameters, spec.name);
  const outputSchema = compileOutputSchema(spec.output.schema);

  const definition = {
    name: spec.name,
    description: spec.description,
    parameters,
    output: {
      schema: outputSchema,
      render: spec.output.render,
    },
    async execute(args, exec) {
      return spec.execute(args, exec);
    },
  };

  if (typeof spec.presentCall === 'function') {
    // Presentation must never throw on replay of older logged arguments.
    definition.presentCall = (args) => {
      try {
        return spec.presentCall(args);
      } catch {
        return undefined;
      }
    };
  }

  return definition;
}
