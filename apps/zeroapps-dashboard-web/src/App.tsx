import { Outlet } from "react-router";
import { AuthProvider } from "@zero/ui";

function App() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

export default App;
