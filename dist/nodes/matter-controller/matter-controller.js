"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const controller_manager_js_1 = require("../../lib/controller-manager.js");
module.exports = function (RED) {
    // HTTP admin endpoint — serves the device registry so node edit UIs can
    // populate cascading dropdowns without manual copy-paste of IDs.
    // No extra auth guard needed: the route is on httpAdmin (admin-only port)
    // and returns only read-only device metadata.
    RED.httpAdmin.get("/matter-nodes/:id/registry", (req, res) => {
        const ctrl = RED.nodes.getNode(req.params["id"]);
        if (!ctrl?.manager) {
            res.json({});
            return;
        }
        res.json(ctrl.manager.getRegistry());
    });
    RED.httpAdmin.post("/matter-nodes/:id/rediscover", (req, res) => {
        const ctrl = RED.nodes.getNode(req.params["id"]);
        if (!ctrl?.manager) {
            res.status(404).json({ error: "Controller not found or not started" });
            return;
        }
        ctrl.manager.rediscoverAll()
            .then(() => res.json({ ok: true }))
            .catch((e) => res.status(500).json({ error: e.message }));
    });
    RED.httpAdmin.get("/matter-nodes/:id/registry/:nodeId/signal", (req, res) => {
        const ctrl = RED.nodes.getNode(req.params["id"]);
        if (!ctrl?.manager) {
            res.status(404).json({ error: "Controller not found or not started" });
            return;
        }
        ctrl.manager.readSignalStrength(req.params["nodeId"])
            .then((info) => res.json(info))
            .catch((e) => res.status(500).json({ error: e.message }));
    });
    RED.httpAdmin.post("/matter-nodes/:id/registry/:nodeId/rename", (req, res) => {
        const ctrl = RED.nodes.getNode(req.params["id"]);
        if (!ctrl?.manager) {
            res.status(404).json({ error: "Controller not found or not started" });
            return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const label = req.body?.label ?? "";
        if (!label.trim()) {
            res.status(400).json({ error: "label is required" });
            return;
        }
        try {
            ctrl.manager.renameDevice(req.params["nodeId"], label);
            res.json({ ok: true });
        }
        catch (e) {
            res.status(404).json({ error: e.message });
        }
    });
    function MatterController(config) {
        RED.nodes.createNode(this, config);
        const storagePath = config.storagePath || `${process.env["HOME"]}/.node-red-matter`;
        const port = parseInt(config.port, 10) || 5540;
        const logLevel = config.logLevel || "Info";
        this.manager = controller_manager_js_1.ControllerManager.getInstance(storagePath, port, logLevel);
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