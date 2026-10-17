"use client";

import { Suspense } from "react";
import DashboardLayout from "@/components/layouts/DashboardLayout";
import ProtectedRoute from "@/components/layouts/ProtectedRoute";
import CreatePaymentStream from "@/components/modules/payment-stream/CreatePaymentStream";
import StreamsHistory from "@/components/modules/payment-stream/StreamsHistory";
import StreamsTableSkeleton from "@/components/modules/payment-stream/StreamsTableSkeleton";
import { SimulationReviewProvider } from "@/components/modules/simulation/SimulationReviewProvider";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ErrorFallback } from "@/components/ui/error-fallback";

const PaymentStreamPage = () => {
    return (
        <DashboardLayout
            title="Payment Streams"
            className="flex flex-col gap-y-6 h-full bg-transparent"
            availableNetwork={["testnet", "mainnet"]}
            infoMessage={{
                type: "warning",
                title: "Beta Feature",
                message: "Feature is in beta mode.",
                showOnNetwork: "mainnet",
            }}
        >
            <ProtectedRoute
                description="Connect your Stellar wallet to create and manage payment streams."
            >
                <SimulationReviewProvider flow="payment-stream">
                    <ErrorBoundary
                        boundaryName="payment-stream-create"
                        fallback={({ error, reset }) => (
                            <ErrorFallback
                                title="Create Stream Unavailable"
                                description="We couldn't load the stream creation form."
                                error={error}
                                onRetry={reset}
                            />
                        )}
                    >
                        <CreatePaymentStream />
                    </ErrorBoundary>

                    <ErrorBoundary
                        boundaryName="payment-stream-history"
                        fallback={({ error, reset }) => (
                            <ErrorFallback
                                title="Stream History Unavailable"
                                description="We couldn't load your stream history right now."
                                error={error}
                                onRetry={reset}
                            />
                        )}
                    >
                        <Suspense fallback={<StreamsTableSkeleton />}>
                            <StreamsHistory />
                        </Suspense>
                    </ErrorBoundary>
                </SimulationReviewProvider>
            </ProtectedRoute>
        </DashboardLayout>
    );
};

export default PaymentStreamPage;
