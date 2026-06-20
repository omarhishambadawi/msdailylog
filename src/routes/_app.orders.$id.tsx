import { createFileRoute } from "@tanstack/react-router";
import { OrderForm } from "./_app.orders.new";

export const Route = createFileRoute("/_app/orders/$id")({
  head: () => ({ meta: [{ title: "Edit Order" }] }),
  component: () => <OrderForm mode="edit" />,
});
