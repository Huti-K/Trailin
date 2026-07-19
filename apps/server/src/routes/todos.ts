import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { Todo } from "@trailin/shared";
import { notFound } from "../core/errors.js";
import { listTodos, type TodoUpdate, updateTodo } from "../db/todos.js";

const idParams = Type.Object({ id: Type.String() });

const statusValue = Type.Union([
  Type.Literal("open"),
  Type.Literal("done"),
  Type.Literal("dismissed"),
]);

const listQuery = Type.Object({ status: Type.Optional(statusValue) });

const patchBody = Type.Object({
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  status: Type.Optional(statusValue),
  dueAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  addSteps: Type.Optional(Type.Array(Type.String())),
  completeSteps: Type.Optional(Type.Array(Type.String())),
  reopenSteps: Type.Optional(Type.Array(Type.String())),
});

export const todosRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/todos", { schema: { querystring: listQuery } }, async (req): Promise<Todo[]> => {
    return listTodos({ status: req.query.status });
  });

  app.patch(
    "/api/todos/:id",
    { schema: { params: idParams, body: patchBody } },
    async (req): Promise<Todo> => {
      const todo = await updateTodo(req.params.id, req.body as TodoUpdate);
      if (!todo) throw notFound("no todo with this id");
      return todo;
    },
  );
};
