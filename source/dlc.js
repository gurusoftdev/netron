
var dlc = dlc || {};
var text = text || require('./text');

dlc.ModelFactory = class {

    match(context) {
        return dlc.Container.open(context);
    }

    open(context, match) {
        return context.require('./dlc-schema').then(() => {
            dlc.schema = flatbuffers.get('dlc').dlc;
            const container = match;
            return dlc.Metadata.open(context).then((metadata) => {
                return new dlc.Model(metadata, container);
            });
        });
    }
};

dlc.Model = class {

    constructor(metadata, container) {
        if (container.metadata.size > 0) {
            const converter = container.metadata.get('converter-command');
            if (converter) {
                const source = converter.split(' ').shift().trim();
                if (source.length > 0) {
                    this._source = source;
                    const version = container.metadata.get('converter-version');
                    if (version) {
                        this._source = this._source + ' v' + version;
                    }
                }
            }
            const version = container.metadata.get('model-version');
            if (version) {
                this._version = version;
            }
        }
        this._format = container.model ? 'DLC' : 'DLC Weights';
        this._graphs = [ new dlc.Graph(metadata, container.model, container.params) ];
    }

    get format() {
        return this._format;
    }

    get source() {
        return this._source;
    }

    get version() {
        return this._version;
    }

    get graphs() {
        return this._graphs;
    }
};

dlc.Graph = class {

    constructor(metadata, model, params) {
        this._inputs = [];
        this._outputs = [];
        const args = new Map();
        const arg = (name) => {
            if (!args.has(name)) {
                args.set(name, new dlc.Argument(name));
            }
            return args.get(name);
        };
        if (model) {
            for (const node of model.nodes) {
                for (const input of node.inputs) {
                    if (!args.has(input)) {
                        args.set(input, {});
                    }
                }
                const shapes = new Array(node.outputs.length);
                for (const attr of node.attributes) {
                    if (attr.name === 'OutputDims') {
                        for (const entry of Object.entries(attr.attributes)) {
                            const index = parseInt(entry[0], 10);
                            shapes[index] = Array.from(entry[1].int32_list);
                        }
                        break;
                    }
                }
                for (let i = 0; i < node.outputs.length; i++) {
                    const output = node.outputs[i];
                    if (!args.has(output)) {
                        args.set(output, {});
                    }
                    const value = args.get(output);
                    if (i < shapes.length) {
                        value.shape = shapes[i];
                    }
                }
            }
            for (const entry of args) {
                const value = entry[1];
                const type = value.shape ? new dlc.TensorType(null, value.shape) : null;
                const argument = new dlc.Argument(entry[0], type);
                args.set(entry[0], argument);
            }
            this._nodes = [];
            const weights = new Map(params ? params.weights.map((weights) => [ weights.name, weights ]) : []);
            for (const node of model.nodes) {
                if (node.type === 'Input') {
                    this._inputs.push(new dlc.Parameter(node.name, node.inputs.map((input) => arg(input))));
                    continue;
                }
                this._nodes.push(new dlc.Node(metadata, node, weights.get(node.name), arg));
            }
        }
        else {
            this._nodes = params.weights.map((weights) => new dlc.Node(metadata, null, weights, arg));
        }
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    get nodes() {
        return this._nodes;
    }
};

dlc.Parameter = class {

    constructor(name, args) {
        this._name = name;
        this._arguments = args;
    }

    get name() {
        return this._name;
    }

    get visible() {
        return true;
    }

    get arguments() {
        return this._arguments;
    }
};

dlc.Argument = class {

    constructor(name, type, initializer) {
        if (typeof name !== 'string') {
            throw new dlc.Error("Invalid argument identifier '" + JSON.stringify(name) + "'.");
        }
        this._name = name;
        this._type = type;
        this._initializer = initializer;
    }

    get name() {
        return this._name;
    }

    get type() {
        return this._type;
    }

    get initializer() {
        return this._initializer;
    }
};

dlc.Node = class {

    constructor(metadata, node, weights, arg) {
        if (node) {
            this._type = metadata.type(node.type);
            this._name = node.name;
            const inputs = Array.from(node.inputs).map((input) => arg(input));
            this._inputs = inputs.length === 0 ? [] : [ new dlc.Parameter(inputs.length === 1 ? 'input' : 'inputs', inputs) ];
            const outputs = Array.from(node.outputs).map((output) => arg(output));
            this._outputs = outputs.length === 0 ? [] : [ new dlc.Parameter(outputs.length === 1 ? 'output' : 'outputs', outputs) ];
            this._attributes = [];
            for (const attr of node.attributes) {
                if (attr.name === 'OutputDims') {
                    continue;
                }
                const attribute = new dlc.Attribute(metadata.attribute(node.type, attr.name), attr);
                this._attributes.push(attribute);
            }
            if (weights) {
                for (const tensor of weights.tensors) {
                    const type = new dlc.TensorType(tensor.data.data_type, tensor.shape);
                    const argument = new dlc.Argument('', type, new dlc.Tensor(type, tensor.data));
                    this._inputs.push(new dlc.Parameter(tensor.name, [ argument ]));
                }
            }
        }
        else {
            this._type = { name: 'Weights' };
            this._name = weights.name;
            this._inputs = weights.tensors.map((tensor) => {
                const type = new dlc.TensorType(tensor.data.data_type, tensor.shape);
                const argument = new dlc.Argument('', type, new dlc.Tensor(type, tensor.data));
                return new dlc.Parameter(tensor.name, [ argument ]);
            });
            this._outputs = [];
            this._attributes = [];
        }
    }

    get type() {
        return this._type;
    }

    get name() {
        return this._name;
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    get attributes() {
        return this._attributes;
    }
};

dlc.Attribute = class {

    constructor(metadata, attr) {
        this._name = attr.name;
        const read = (attr) => {
            switch (attr.type) {
                case 1: return [ 'boolean',   attr.bool_value               ];
                case 2: return [ 'int32',     attr.int32_value              ];
                case 3: return [ 'uint32',    attr.uint32_value             ];
                case 4: return [ 'float32',   attr.float32_value            ];
                case 5: return [ 'string',    attr.string_value             ];
                case 7: return [ 'byte[]',    Array.from(attr.byte_list)    ];
                case 8: return [ 'int32[]',   Array.from(attr.int32_list)   ];
                case 9: return [ 'float32[]', Array.from(attr.float32_list) ];
                case 11: {
                    const obj = {};
                    for (const attribute of attr.attributes) {
                        const entry = read(attribute);
                        obj[attribute.name] = entry[1];
                    }
                    return [ '', obj ];
                }
                default:
                    throw new dlc.Error("Unsupported attribute type '" + attr.type + "'.");
            }
        };
        const entry = read(attr);
        if (entry) {
            this._type = entry[0];
            this._value = entry[1];
        }
        if (metadata && metadata.type) {
            this._type = metadata.type;
            this._value = dlc.Utility.enum(this._type, this._value);
        }
    }

    get name() {
        return this._name;
    }

    get type() {
        return this._type;
    }

    get value() {
        return this._value;
    }
};

dlc.TensorType = class {

    constructor(dataType, shape) {
        switch (dataType) {
            case null: this._dataType = '?'; break;
            case 6: this._dataType = 'uint8'; break;
            case 9: this._dataType = 'float32'; break;
            default:
                throw new dlc.Error("Unsupported data type '" + JSON.stringify(dataType) + "'.");
        }
        this._shape = new dlc.TensorShape(shape);
    }

    get dataType() {
        return this._dataType;
    }

    get shape() {
        return this._shape;
    }

    toString() {
        return this.dataType + this._shape.toString();
    }
};

dlc.TensorShape = class {

    constructor(dimensions) {
        this._dimensions = Array.from(dimensions);
    }

    get dimensions() {
        return this._dimensions;
    }

    toString() {
        if (!this._dimensions || this._dimensions.length == 0) {
            return '';
        }
        return '[' + this._dimensions.map((dimension) => dimension.toString()).join(',') + ']';
    }
};

dlc.Tensor = class {

    constructor(type, data) {
        this._type = type;
        switch (type.dataType) {
            case 'uint8': this._data = data.bytes; break;
            case 'float32': this._data = data.floats; break;
            default: throw new dlc.Error("Unsupported tensor data type '" + type.dataType + "'.");
        }
    }

    get type() {
        return this._type;
    }

    get state() {
        return this._context().state || null;
    }

    get value() {
        const context = this._context();
        if (context.state) {
            return null;
        }
        context.limit = Number.MAX_SAFE_INTEGER;
        return this._decode(context, 0);
    }

    toString() {
        const context = this._context();
        if (context.state) {
            return '';
        }
        context.limit = 10000;
        const value = this._decode(context, 0);
        return JSON.stringify(value, null, 4);
    }

    _context() {
        const context = {};
        context.state = null;
        context.index = 0;
        context.count = 0;
        context.shape = this._type.shape.dimensions;
        context.data = this._data;
        return context;
    }

    _decode(context, dimension) {
        const results = [];
        const size = context.shape[dimension];
        if (dimension == context.shape.length - 1) {
            for (let i = 0; i < size; i++) {
                if (context.count > context.limit) {
                    results.push('...');
                    return results;
                }
                results.push(context.data[context.index]);
                context.index++;
                context.count++;
            }
        }
        else {
            for (let j = 0; j < size; j++) {
                if (context.count > context.limit) {
                    results.push('...');
                    return results;
                }
                results.push(this._decode(context, dimension + 1));
            }
        }
        return results;
    }
};

dlc.Container = class {

    static open(context) {
        const entries = context.entries('zip');
        if (entries.size > 0) {
            const model = entries.get('model');
            const params = entries.get('model.params');
            if (model || params) {
                return new dlc.Container(model, params, entries.get('dlc.metadata'));
            }
        }
        const stream = context.stream;
        switch (dlc.Container._idenfitier(stream)) {
            case 'NETD':
                return new dlc.Container(stream, null, null);
            case 'NETP':
                return new dlc.Container(null, stream, null);
            default:
                break;
        }
        return null;
    }

    constructor(model, params, metadata) {
        this._model = model || null;
        this._params = params || null;
        this._metadata = metadata || new Uint8Array(0);
    }

    get model() {
        if (this._model && this._model.peek) {
            const stream = this._model;
            const reader = this._open(stream, 'NETD');
            stream.seek(0);
            this._model = dlc.schema.NetDefinition.decode(reader, reader.root);
        }
        return this._model;
    }

    get params() {
        if (this._params && this._params.peek) {
            const stream = this._params;
            const reader = this._open(stream, 'NETP');
            stream.seek(0);
            this._params = dlc.schema.NetParameters.decode(reader, reader.root);
        }
        return this._params;
    }

    get metadata() {
        if (this._metadata && this._metadata.peek) {
            const reader = text.Reader.open(this._metadata);
            const metadata = new Map();
            for (;;) {
                const line = reader.read();
                if (line === undefined) {
                    break;
                }
                const index = line.indexOf('=');
                if (index === -1) {
                    break;
                }
                const key = line.substring(0, index);
                const value = line.substring(index + 1);
                metadata.set(key, value);
            }
            this._metadata = metadata;
        }
        return this._metadata;
    }

    _open(stream, identifier) {
        if (dlc.Container._signature(stream, [ 0xD5, 0x0A, 0x02, 0x00 ])) {
            throw new dlc.Error("Unsupported DLC format '0x00020AD5'.");
        }
        if (dlc.Container._signature(stream, [ 0xD5, 0x0A, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00 ])) {
            stream.read(8);
        }
        const buffer = new Uint8Array(stream.read());
        const reader = flatbuffers.BinaryReader.open(buffer);
        if (identifier != reader.identifier) {
            throw new dlc.Error("File contains undocumented '" + reader.identifier + "' data.");
        }
        return reader;
    }

    static _idenfitier(stream) {
        if (dlc.Container._signature(stream, [ 0xD5, 0x0A, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00 ])) {
            const buffer = stream.peek(16).slice(8, 16);
            const reader = flatbuffers.BinaryReader.open(buffer);
            return reader.identifier;
        }
        else if (stream.length > 8) {
            const buffer = stream.peek(8);
            const reader = flatbuffers.BinaryReader.open(buffer);
            return reader.identifier;
        }
        return '';
    }

    static _signature(stream, signature) {
        return stream.length > 16 && stream.peek(signature.length).every((value, index) => value === signature[index]);
    }
};

dlc.Metadata = class {

    static open(context) {
        if (dlc.Metadata._metadata) {
            return Promise.resolve(dlc.Metadata._metadata);
        }
        return context.request('dlc-metadata.json', 'utf-8', null).then((data) => {
            dlc.Metadata._metadata = new dlc.Metadata(data);
            return dlc.Metadata._metadata;
        }).catch(() => {
            dlc.Metadata._metadata = new dlc.Metadata(null);
            return dlc.Metadata._metadata;
        });
    }

    constructor(data) {
        this._types = new Map();
        this._attributes = new Map();
        if (data) {
            const metadata = JSON.parse(data);
            this._types = new Map(metadata.map((item) => [ item.name, item ]));
        }
    }

    type(name) {
        if (!this._types.has(name)) {
            this._types.set(name, { name: name });
        }
        return this._types.get(name);
    }

    attribute(type, name) {
        const key = type + ':' + name;
        if (!this._attributes.has(key)) {
            this._attributes.set(key, null);
            const metadata = this.type(type);
            if (metadata && Array.isArray(metadata.attributes)) {
                for (const attribute of metadata.attributes) {
                    this._attributes.set(type + ':' + attribute.name, attribute);
                }
            }
        }
        return this._attributes.get(key);
    }
};

dlc.Utility = class {

    static enum(name, value) {
        const type = name && dlc.schema ? dlc.schema[name] : undefined;
        if (type) {
            dlc.Utility._enums = dlc.Utility._enums || new Map();
            if (!dlc.Utility._enums.has(name)) {
                const map = new Map(Object.keys(type).map((key) => [ type[key], key ]));
                dlc.Utility._enums.set(name, map);
            }
            const map = dlc.Utility._enums.get(name);
            if (map.has(value)) {
                return map.get(value);
            }
        }
        return value;
    }
};

dlc.Error = class extends Error {

    constructor(message) {
        super(message);
        this.name = 'Error loading DLC model.';
        this.stack = undefined;
    }
};

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
    module.exports.ModelFactory = dlc.ModelFactory;
}
