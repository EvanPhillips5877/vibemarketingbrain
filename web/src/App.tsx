import { useQuery } from "@tanstack/react-query";
import { Route, Switch } from "wouter";
import { api, ApiError, rememberCsrf, type Me } from "./api";
import { BrandList, BrandPage } from "./pages/Brands";
import { Campaigns } from "./pages/Campaigns";
import { Creative } from "./pages/Creative";
import { Missions } from "./pages/Missions";
import { Learnings } from "./pages/Learnings";
import { Today } from "./pages/Today";
import { Placeholder } from "./pages/Placeholder";
import { Settings } from "./pages/Settings";
import { Shell } from "./pages/Shell";
import { SignIn } from "./pages/SignIn";

export function App() {
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const data = await api<Me>("/api/me");
      rememberCsrf(data.csrfToken);
      return data;
    },
  });

  if (me.isPending) {
    return <div className="p-8 text-sm text-neutral-500">Loading…</div>;
  }
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401) {
      return <SignIn onSignedIn={() => void me.refetch()} />;
    }
    return <div className="p-8 text-sm text-red-600">Could not reach MarketingBrain: {me.error.message}</div>;
  }

  return (
    <Shell me={me.data}>
      <Switch>
        <Route path="/">
          <Today />
        </Route>
        <Route path="/missions">
          <Missions />
        </Route>
        <Route path="/creative">
          <Creative />
        </Route>
        <Route path="/campaigns">
          <Campaigns />
        </Route>
        <Route path="/learnings">
          <Learnings />
        </Route>
        <Route path="/brands">
          <BrandList />
        </Route>
        <Route path="/brands/:slug">
          <BrandPage />
        </Route>
        <Route path="/settings">
          <Settings me={me.data} />
        </Route>
        <Route>
          <Placeholder title="Not found" blurb="There is nothing at this address." />
        </Route>
      </Switch>
    </Shell>
  );
}
