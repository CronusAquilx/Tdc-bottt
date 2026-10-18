import React from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import { HomePage } from "@/pages/home";
import { RaffleDetail } from "@/pages/raffle-detail";
import {
  AccountsPage, ChannelsPage, CrewPage, OrdersPage, PortalAuthPage, StaffHome,
} from "@/pages/staff";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={() => <Layout><HomePage /></Layout>} />
      <Route path="/raffle/:id" component={() => <Layout><RaffleDetail /></Layout>} />
      <Route path="/staff/login" component={() => <PortalAuthPage mode="login" />} />
      <Route path="/staff/setup" component={() => <PortalAuthPage mode="setup" />} />
      <Route path="/staff/activate" component={() => <PortalAuthPage mode="activate" />} />
      <Route path="/staff/orders" component={OrdersPage} />
      <Route path="/staff/crew" component={CrewPage} />
      <Route path="/staff/channels" component={ChannelsPage} />
      <Route path="/staff/accounts" component={AccountsPage} />
      <Route path="/staff" component={StaffHome} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
