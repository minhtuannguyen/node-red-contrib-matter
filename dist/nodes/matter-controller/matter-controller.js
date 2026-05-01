"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const controller_manager_js_1 = require("../../lib/controller-manager.js");
module.exports = function (RED) {
    function MatterController(config) {
        RED.nodes.createNode(this, config);
        const storagePath = config.storagePath || `${process.env["HOME"]}/.node-red-matter`;
        const port = parseInt(config.port, 10) || 5540;
        this.manager = controller_manager_js_1.ControllerManager.getInstance(storagePath, port);
        this.manager.start().then(() => {
            this.log(`Matter controller ready — storage: ${storagePath}`);
        }).catch((err) => {
            this.error(`Failed to start Matter controller: ${err.message}`);
        });
        this.on("close", (_removed, done) => {
            this.manager.close().finally(done);
        });
    }
    RED.nodes.registerType("matter-controller", MatterController);
};
//# sourceMappingURL=matter-controller.js.map