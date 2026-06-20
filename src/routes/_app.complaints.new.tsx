import { createFileRoute } from "@tanstack/react-router";
import { ComplaintForm } from "./_app.complaints.$id";

export const Route = createFileRoute("/_app/complaints/new")({
  head: () => ({ meta: [{ title: "New Complaint" }] }),
  component: () => <ComplaintForm mode="create" />,
});
