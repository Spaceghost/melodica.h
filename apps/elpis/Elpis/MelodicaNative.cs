using System;
using System.Runtime.InteropServices;

namespace Elpis
{
    internal static class MelodicaNative
    {
        private const uint RequiredAbi = 1;

        [DllImport("melodica", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint melodica_abi_version();

        internal static bool TryInitialize()
        {
            try
            {
                return melodica_abi_version() == RequiredAbi;
            }
            catch (DllNotFoundException)
            {
                return false;
            }
            catch (BadImageFormatException)
            {
                return false;
            }
            catch (EntryPointNotFoundException)
            {
                return false;
            }
        }
    }
}
