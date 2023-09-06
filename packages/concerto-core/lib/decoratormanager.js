/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const ModelManager = require('./modelmanager');
const Serializer = require('./serializer');
const Factory = require('./factory');

const DCS_MODEL = `concerto version "^3.0.0"
namespace org.accordproject.decoratorcommands@0.2.0

import concerto.metamodel@1.0.0.Decorator

/**
 * A reference to an existing named & versioned DecoratorCommandSet
 */
concept DecoratorCommandSetReference {
    o String name
    o String version
}

/**
 * Whether to upsert or append the decorator
 */
enum CommandType {
    o UPSERT
    o APPEND
}

/**
 * Which models elements to add the decorator to. Any null
 * elements are 'wildcards'. 
 */
concept CommandTarget {
    o String namespace optional
    o String declaration optional
    o String property optional
    o String type optional 
}

/**
 * Applies a decorator to a given target
 */
concept Command {
    o CommandTarget target
    o Decorator decorator
    o CommandType type
}

/**
 * A named and versioned set of commands. Includes are supported for modularity/reuse.
 */
concept DecoratorCommandSet {
    o String name
    o String version
    o DecoratorCommandSetReference[] includes optional
    o Command[] commands
}
`;

/**
 * Utility functions to work with
 * [DecoratorCommandSet](https://models.accordproject.org/concerto/decorators.cto)
 * @memberof module:concerto-core
 */
class DecoratorManager {
    /**
     * Applies all the decorator commands from the DecoratorCommandSet
     * to the ModelManager.
     * @param {ModelManager} modelManager the input model manager
     * @param {*} decoratorCommandSet the DecoratorCommandSet object
     * @param {object} [options] - decorator models options
     * @param {boolean} [options.validate] - validate that decorator command set is valid
     * with respect to to decorator command set model
     * @param {boolean} [options.validateCommands] - validate the decorator command set targets. Note that
     * the validate option must also be true
     * @returns {ModelManager} a new model manager with the decorations applied
     */
    static decorateModels(modelManager, decoratorCommandSet, options) {
        if(options?.validate) {
            const validationModelManager = new ModelManager({strict:true, metamodelValidation: true, addMetamodel: true});
            validationModelManager.addModelFiles(modelManager.getModelFiles());
            validationModelManager.addCTOModel(DCS_MODEL, 'decoratorcommands@0.2.0.cto');
            const factory = new Factory(validationModelManager);
            const serializer = new Serializer(factory, validationModelManager);
            serializer.fromJSON(decoratorCommandSet);
            if(options?.validateCommands) {
                decoratorCommandSet.commands.forEach(command => {
                    DecoratorManager.validateCommand(validationModelManager, command);
                });
            }
        }
        const ast = modelManager.getAst(true);
        const decoratedAst = JSON.parse(JSON.stringify(ast));
        decoratedAst.models.forEach(model => {
            model.declarations.forEach(decl => {
                decoratorCommandSet.commands.forEach(command => {
                    this.executeCommand(model.namespace, decl, command);
                });
            });
        });
        const newModelManager = new ModelManager();
        newModelManager.fromAst(decoratedAst);
        return newModelManager;
    }

    /**
     * Throws an error if the decoractor command is invalid
     * @param {ModelManager} validationModelManager the validation model manager
     * @param {*} command the decorator command
     */
    static validateCommand(validationModelManager, command) {
        if(command.target.type) {
            validationModelManager.resolveType( 'DecoratorCommand.type', command.target.type);
        }
        if(command.target.namespace) {
            const modelFile = validationModelManager.getModelFile(command.target.namespace);
            if(!modelFile) {
                throw new Error(`Decorator Command references namespace "${command.target.namespace}" which does not exist.`);
            }
        }
        if(command.target.namespace && command.target.declaration) {
            validationModelManager.resolveType( 'DecoratorCommand.target.declaration', `${command.target.namespace}.${command.target.declaration}`);
        }
        if(command.target.namespace && command.target.declaration && command.target.property) {
            const decl = validationModelManager.getType(`${command.target.namespace}.${command.target.declaration}`);
            const property = decl.getProperty(command.target.property);
            if(!property) {
                throw new Error(`Decorator Command references property "${command.target.namespace}.${command.target.declaration}.${command.target.property}" which does not exist.`);
            }
        }
    }

    /**
     * Compares two values. If the first argument is falsy
     * the function returns true.
     * @param {string | null} test the value to test (lhs)
     * @param {string} value the value to compare (rhs)
     * @returns {Boolean} true if the lhs is falsy or test === value
     */
    static falsyOrEqual(test, value) {
        return test ? test === value : true;
    }

    /**
     * Applies a decorator to a decorated model element.
     * @param {*} decorated the type to apply the decorator to
     * @param {string} type the command type
     * @param {*} newDecorator the decorator to add
     */
    static applyDecorator(decorated, type, newDecorator) {
        if (type === 'UPSERT') {
            let updated = false;
            if(decorated.decorators) {
                for (let n = 0; n < decorated.decorators.length; n++) {
                    let decorator = decorated.decorators[n];
                    if (decorator.name === newDecorator.name) {
                        decorated.decorators[n] = newDecorator;
                        updated = true;
                    }
                }
            }

            if (!updated) {
                decorated.decorators ? decorated.decorators.push(newDecorator)
                    : decorated.decorators = [newDecorator];
            }
        }
        else if (type === 'APPEND') {
            decorated.decorators ? decorated.decorators.push(newDecorator)
                : decorated.decorators = [newDecorator];
        }
        else {
            throw new Error(`Unknown command type ${type}`);
        }
    }

    /**
     * Executes a Command against a ClassDeclaration, adding
     * decorators to the ClassDeclaration, or its properties, as required.
     * @param {string} namespace the namespace for the declaration
     * @param {*} declaration the class declaration
     * @param {*} command the Command object from the
     * org.accordproject.decoratorcommands model
     */
    static executeCommand(namespace, declaration, command) {
        const { target, decorator, type } = command;
        if (this.falsyOrEqual(target.namespace, namespace) &&
            this.falsyOrEqual(target.declaration, declaration.name)) {
            if (!target.property && !target.type) {
                this.applyDecorator(declaration, type, decorator);
            }
            else {
                // scalars are declarations but do not have properties
                if(declaration.properties) {
                    declaration.properties.forEach(property => {
                        if (this.falsyOrEqual(target.property, property.name) &&
                            this.falsyOrEqual(target.type, property.$class)) {
                            this.applyDecorator(property, type, decorator);
                        }
                    });
                }
            }
        }
    }
}

module.exports = DecoratorManager;
