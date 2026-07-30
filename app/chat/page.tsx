import { redirect } from "next/navigation";

/** Legacy path — chat is now the home page. */
export default function ChatRedirect() {
  redirect("/");
}
