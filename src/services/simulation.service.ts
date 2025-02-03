import { ethers } from 'ethers';
import { UniswapService } from './uniswap.service';

export class SimulationService {
    private uniswapService: UniswapService;
    private readonly WETH = "0x4200000000000000000000000000000000000006"; // WETH di Base
    private readonly USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC di Base

    constructor() {
        this.uniswapService = new UniswapService();
    }

    async simulateTradeWithRealData(amountInEth: string) {
        try {
            const amountIn = ethers.parseEther(amountInEth);
            
            // Get real quote from Uniswap V3 pool
            const quoteAmount = await this.uniswapService.getQuote(
                this.WETH,
                this.USDC,
                amountIn
            );

            const simulatedResult = {
                tokenIn: this.WETH,
                tokenOut: this.USDC,
                amountIn: ethers.formatEther(amountIn) + ' ETH',
                estimatedAmountOut: (Number(quoteAmount) / 1e6).toFixed(2) + ' USDC', // Format USDC with 6 decimals
                estimatedGas: '200000',
                simulationTime: new Date().toISOString(),
                success: true
            };

            return simulatedResult;
        } catch (error) {
            console.error('Error in real trade simulation:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    async simulateMultipleTrades() {
        const scenarios = [
            {
                description: 'ETH to USDC - Micro Amount',
                amountIn: '0.0001'
            },
            {
                description: 'ETH to USDC - Small Amount',
                amountIn: '0.001'
            },
            {
                description: 'ETH to USDC - Medium Amount',
                amountIn: '0.01'
            },
            {
                description: 'ETH to USDC - Standard Amount',
                amountIn: '0.1'
            },
            {
                description: 'ETH to USDC - Large Amount',
                amountIn: '1.0'
            }
        ];

        const results = [];

        for (const scenario of scenarios) {
            try {
                const result = await this.simulateTradeWithRealData(scenario.amountIn);
                results.push({
                    ...scenario,
                    result
                });
            } catch (error) {
                results.push({
                    ...scenario,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        }

        return results;
    }
} 