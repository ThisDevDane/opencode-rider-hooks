import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { configuredProjectPath } from "../projects.ts"

describe("Rider MCP configuration", () => {
  test("reads HTTP project-path headers case-insensitively", () => {
    for (const name of ["IJ_MCP_SERVER_PROJECT_PATH", "ij_mcp_server_project_path"]) {
      assert.equal(configuredProjectPath({
        type: "remote",
        url: "http://localhost:64342/stream",
        headers: { [name]: " /checkout/backend " },
      }), "/checkout/backend")
    }
  })

  test("reads the stdio environment rather than the process directory", () => {
    assert.equal(configuredProjectPath({
      type: "local",
      command: ["rider", "stdioMcpServer"],
      cwd: "/checkout",
      environment: { IJ_MCP_SERVER_PROJECT_PATH: "/checkout/backend" },
    }), "/checkout/backend")
  })

  test("does not infer a selector from cwd, URLs, or unrelated headers", () => {
    assert.equal(configuredProjectPath({
      type: "local",
      command: ["rider", "stdioMcpServer"],
      cwd: "/checkout/backend",
    }, {}), undefined)
    assert.equal(configuredProjectPath({
      type: "remote",
      url: "http://localhost:64342/checkout/backend",
      headers: { "Some-Other-Header": "/checkout/backend" },
    }), undefined)
  })

  test("stdio inherits its project selector unless explicitly overridden", () => {
    const environment = { IJ_MCP_SERVER_PROJECT_PATH: "/checkout/backend" }
    assert.equal(configuredProjectPath({
      type: "local", command: ["rider", "stdioMcpServer"],
    }, environment), "/checkout/backend")
    assert.equal(configuredProjectPath({
      type: "local", command: ["rider", "stdioMcpServer"],
      environment: { IJ_MCP_SERVER_PROJECT_PATH: "" },
    }, environment), undefined)
    assert.equal(configuredProjectPath({
      type: "remote", url: "http://localhost:64342/stream",
    }, environment), undefined)
  })

  test("treats missing, blank, and disabled selectors as absent", () => {
    assert.equal(configuredProjectPath(undefined), undefined)
    assert.equal(configuredProjectPath({
      type: "remote",
      url: "http://localhost:64342/stream",
      headers: { IJ_MCP_SERVER_PROJECT_PATH: "  " },
    }), undefined)
    assert.equal(configuredProjectPath({
      type: "remote",
      url: "http://localhost:64342/stream",
      headers: { IJ_MCP_SERVER_PROJECT_PATH: "/checkout/backend" },
      disabled: true,
    }), undefined)
  })
})
